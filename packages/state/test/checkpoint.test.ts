import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestArtifact, identifyManifest, type ArtifactManifest, type BaseTreeAnchor } from '@loopwright/core';
import { fixture, good, checkpoint } from './fixtures.js';
test('checkpoint publication captures one current ledger/authority/clock view',()=>{const f=fixture({},10000);try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const saved=good(s.writeCheckpoint(owner.authority,checkpoint(owner.revision)));assert.equal(saved.record.publishedRevision,owner.revision+1);assert.equal(saved.record.generation,owner.authority.generation);}finally{s.close();}}finally{f.cleanup();}});

import { DatabaseSync } from 'node:sqlite';
import { errorCode, request } from './fixtures.js';
import { reopenLocalRun, type CheckpointRecord, type Page, type PageCursor } from '../src/index.js';
import { LocalRunStore } from '../src/store.js';
import { openInternal } from '../src/connection.js';

test('historical checkpoint recovery reads current ledger, uncertainty, deadline and authority',()=>{
  const f=fixture({},10000);try{let s=f.create();const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));good(s.reserveRequest(owner.authority,request()));good(s.authorizeRequestDispatch(owner.authority,'request-1'));const before=good(s.inspect());const input=checkpoint(before.revision);const saved=good(s.writeCheckpoint(owner.authority,input));assert.deepEqual(saved.record.ledger,before.ledger);assert.deepEqual(saved.record.clockBasis,before.clock.basis);assert.equal(saved.record.clockSample.monotonicMs,good(s.inspect()).clock.lastCommittedSample.monotonicMs);good(s.reserveRequest(owner.authority,request('later')));const current=good(s.inspect());assert.equal(current.ledger.chargedTokens.decimal,'200');assert.equal(saved.record.ledger.chargedTokens.decimal,'100');assert.equal(good(s.writeCheckpoint(owner.authority,input)).kind,'existing');
    s.close();s=good(reopenLocalRun(f.input));try{const view=good(s.recoveryView(owner.authority,{checkpointId:input.checkpointId,availableArtifacts:[input.workspace]}));assert.equal(view.current.ledger.chargedTokens.decimal,'200');assert.equal(view.current.ledger.admittedCalls,2);assert.equal(view.checkpoint.ledger.chargedTokens.decimal,'100');assert.equal(view.ledgerAdvanced,true);assert.equal(view.requiresReconciliation,true);assert.equal(view.current.deadlineMs,before.deadlineMs);assert.deepEqual(view.current.clock.basis,before.clock.basis);assert.equal('permit'in view,false);
      const release=good(s.release(owner.authority));const newOwner=good(s.claim({ownerId:'owner-2',expectedGeneration:release.record.generation,expectedRevision:release.revision,mode:'recovery'}));errorCode(s.recoveryView(owner.authority,{checkpointId:input.checkpointId,availableArtifacts:[input.workspace]}),'STALE_OWNER');const after=good(s.recoveryView(newOwner.authority,{checkpointId:input.checkpointId,availableArtifacts:[input.workspace]}));assert.equal(after.current.owner.generation,newOwner.authority.generation);assert.equal(after.current.ledger.chargedTokens.decimal,'200');assert.equal(after.checkpoint.generation,owner.authority.generation);
    }finally{s.close();}
  }finally{f.cleanup();}
});
test('checkpoint freshness and complete reference identity fail explicitly without writing partial data',()=>{const f=fixture({},10000);try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const input=checkpoint(owner.revision);good(s.writeCheckpoint(owner.authority,input));errorCode(s.writeCheckpoint(owner.authority,checkpoint(owner.revision,'stale')),'CHECKPOINT_STALE');errorCode(s.writeCheckpoint(owner.authority,{...input,workspace:{...input.workspace,byteLength:1}}),'IDENTITY_CONFLICT');errorCode(s.recoveryView(owner.authority,{checkpointId:input.checkpointId,availableArtifacts:[]}),'ARTIFACT_REQUIRED');errorCode(s.recoveryView(owner.authority,{checkpointId:input.checkpointId,availableArtifacts:[{...input.workspace,byteLength:1}]}),'ARTIFACT_REQUIRED');errorCode(s.getCheckpoint('missing'),'RECORD_NOT_FOUND');assert.equal(good(s.inspect()).counts.checkpoints,1);
  const withSession={...checkpoint(good(s.inspect()).revision,'session'),privateSession:structuredClone({...input.workspace,name:'private.session'}),additionalArtifacts:[structuredClone({...input.workspace,name:'extra.ref'})]};good(s.writeCheckpoint(owner.authority,withSession));errorCode(s.recoveryView(owner.authority,{checkpointId:'session',availableArtifacts:[withSession.workspace]}),'ARTIFACT_REQUIRED');good(s.recoveryView(owner.authority,{checkpointId:'session',availableArtifacts:[withSession.workspace,withSession.privateSession,...withSession.additionalArtifacts]}));
  }finally{s.close();}}finally{f.cleanup();}});
test('checkpoint input and returned objects cannot alias persistent state',()=>{const f=fixture({},10000);try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const input=checkpoint(owner.revision);const saved=good(s.writeCheckpoint(owner.authority,input));(input.workspace.digest as {hex:string}).hex='c'.repeat(64);assert.equal(good(s.getCheckpoint(input.checkpointId)).workspace.digest.hex,'a'.repeat(64));assert.throws(()=>{(saved.record.clockBasis.created as {wallMs:number}).wallMs=0;},TypeError);assert(Object.isFrozen(saved.record.ledger));assert.equal(good(s.inspect()).startedAtMs,saved.record.startedAtMs);}finally{s.close();}}finally{f.cleanup();}});
test('missing/corrupt checkpoint rows reject reopen without rebuilding authority',()=>{for(const sql of ["DELETE FROM checkpoints","UPDATE checkpoints SET checkpoint_json='{}'"]){const f=fixture({},10000);try{const s=f.create();const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));good(s.writeCheckpoint(owner.authority,checkpoint(owner.revision)));s.close();const db=new DatabaseSync(f.path);db.exec(sql);db.close();errorCode(reopenLocalRun(f.input),'STORE_CORRUPT');}finally{f.cleanup();}}});
test('recovery after elapsed deadline preserves the immutable basis and negative remaining time',()=>{const f=fixture({wallTimeMs:1000},10000);let now={wallMs:100000,monotonicMs:'10000'};try{let s=new LocalRunStore(openInternal(f.input,'create',{clock:()=>now}));const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));const input=checkpoint(owner.revision);const old=good(s.writeCheckpoint(owner.authority,input));s.close();now={wallMs:101500,monotonicMs:'11500'};s=new LocalRunStore(openInternal(f.input,'reopen',{clock:()=>now}));try{const view=good(s.recoveryView(owner.authority,{checkpointId:input.checkpointId,availableArtifacts:[input.workspace]}));assert.equal(view.current.clock.remainingTaskMs.decimal,'-500');assert.deepEqual(view.current.clock.basis,old.record.clockBasis);errorCode(s.reserveRequest(owner.authority,request()),'DEADLINE_EXCEEDED');}finally{s.close();}}finally{f.cleanup();}});
test('pages bind store, collection and revision and never retain a cross-page transaction',()=>{const f=fixture({},10000);try{const s=f.create();try{const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));for(let i=0;i<3;i++){good(s.reserveRequest(owner.authority,request(`page-${i}`)));good(s.releaseReservation(owner.authority,`page-${i}`));}const first=good(s.listRequests({limit:1,cursor:null}));assert.equal(first.items.length,1);assert.notEqual(first.next,null);const next=good(s.listRequests({limit:1,cursor:first.next}));assert.equal(next.items[0]!.sequence,2);errorCode(s.listOperations({limit:1,cursor:first.next}),'INVALID_INPUT');errorCode(s.listRequests({limit:101,cursor:null}),'INVALID_INPUT');const wrong={...first.next!,storeId:'wrong-store'} satisfies PageCursor;errorCode(s.listRequests({limit:1,cursor:wrong}),'IDENTITY_CONFLICT');good(s.renew(owner.authority));errorCode(s.listRequests({limit:1,cursor:first.next}),'REVISION_CONFLICT');assert.equal(good(s.listRequests({limit:100,cursor:null})).items.length,3);}finally{s.close();}}finally{f.cleanup();}});

test('checkpoints #1 through #256 persist in deterministic sequence order and #257 fails closed with LIMIT_EXCEEDED',()=>{
  const f=fixture({},60000);
  const now={wallMs:100000,monotonicMs:'10000'};
  try{
    const s=new LocalRunStore(openInternal(f.input,'create',{clock:()=>now}));
    try{
      const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));
      for(let i=1;i<=256;i++){
        const view=good(s.inspect());
        const saved=good(s.writeCheckpoint(owner.authority,checkpoint(view.revision,`cp-${i}`)));
        assert.equal(saved.kind,'created');
        assert.equal(saved.record.sequence,i);
      }
      const atLimit=good(s.inspect());
      assert.equal(atLimit.counts.checkpoints,256);
      errorCode(s.writeCheckpoint(owner.authority,checkpoint(atLimit.revision,'cp-257')),'LIMIT_EXCEEDED');
      assert.equal(good(s.inspect()).revision,atLimit.revision);
      assert.equal(good(s.inspect()).counts.checkpoints,256);

      const sequences:number[]=[];
      let cursor:PageCursor|null=null;
      for(;;){
        const page:Page<CheckpointRecord>=good(s.listCheckpoints({limit:100,cursor}));
        for(const item of page.items)sequences.push(item.sequence);
        if(page.next===null)break;
        cursor=page.next;
      }
      assert.equal(sequences.length,256);
      assert.deepEqual(sequences,Array.from({length:256},(_,i)=>i+1));
      assert.equal(good(s.getCheckpoint('cp-1')).sequence,1);
      assert.equal(good(s.getCheckpoint('cp-65')).sequence,65);
      assert.equal(good(s.getCheckpoint('cp-256')).sequence,256);
    }finally{s.close();}
  }finally{f.cleanup();}
});

test('reopening a store with <= 64 checkpoints continues appending #65+ and stale leases reject writes past #64',()=>{
  const f=fixture({},1000);
  let now={wallMs:100000,monotonicMs:'10000'};
  try{
    let s=new LocalRunStore(openInternal(f.input,'create',{clock:()=>now}));
    const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));
    for(let i=1;i<=64;i++){
      const view=good(s.inspect());
      good(s.writeCheckpoint(owner.authority,checkpoint(view.revision,`cp-${i}`)));
    }
    s.close();

    s=new LocalRunStore(openInternal(f.input,'reopen',{clock:()=>now}));
    try{
      const reopened=good(s.inspect());
      assert.equal(reopened.counts.checkpoints,64);
      const cp65=good(s.writeCheckpoint(owner.authority,checkpoint(reopened.revision,'cp-65')));
      assert.equal(cp65.record.sequence,65);

      const release=good(s.release(owner.authority));
      const newOwner=good(s.claim({ownerId:'owner-2',expectedGeneration:release.record.generation,expectedRevision:release.revision,mode:'recovery'}));
      errorCode(s.writeCheckpoint(owner.authority,checkpoint(newOwner.revision,'cp-66-stale')),'STALE_OWNER');

      now={wallMs:101500,monotonicMs:'11500'};
      errorCode(s.writeCheckpoint(newOwner.authority,checkpoint(newOwner.revision,'cp-66-expired')),'OWNER_EXPIRED');

      const renewed=good(s.claim({ownerId:'owner-3',expectedGeneration:newOwner.authority.generation,expectedRevision:newOwner.revision,mode:'active'}));
      const cp66=good(s.writeCheckpoint(renewed.authority,checkpoint(renewed.revision,'cp-66')));
      assert.equal(cp66.record.sequence,66);
      assert.equal(good(s.inspect()).counts.checkpoints,66);
    }finally{s.close();}
  }finally{f.cleanup();}
});

function buildOverlayManifest(count:number,uriPrefix?:string):ArtifactManifest {
  const baseTree:BaseTreeAnchor={objectFormat:'sha256',commitOid:'c'.repeat(64),treeOid:'d'.repeat(64)};
  const entries=Array.from({length:count},(_,i)=>{
    const name=`src/file-${String(i).padStart(4,'0')}.ts`;
    const ref=digestArtifact(name,Buffer.from(`content-${i}`),uriPrefix?{uri:`${uriPrefix}${String(i).padStart(4,'0')}.ts`}:undefined);
    if(!ref.ok)throw new Error(`digestArtifact failed: ${JSON.stringify(ref.errors)}`);
    return ref.value;
  });
  return {apiVersion:'loopwright.dev/v1alpha1',kind:'ArtifactManifest',metadata:{id:'candidate'},spec:{baseTree,entries,deleted:[]}};
}

test('contract-scoped budgets.overlay persists 512-file overlay candidateManifest across reopen and rejects 513-file manifest with INVALID_INPUT',()=>{
  const overlay={maxFiles:512,maxBytes:16_777_216} as const;
  const f=fixture({overlay},60000);
  try{
    let s=f.create();
    const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));
    const overlay512=buildOverlayManifest(512);
    const identified=identifyManifest(overlay512,{overlay});
    assert.equal(identified.ok,true);
    if(!identified.ok)throw new Error('expected 512-file overlay manifest to identify');

    const input={...checkpoint(owner.revision,'cp-overlay-512'),candidateManifest:overlay512};
    const saved=good(s.writeCheckpoint(owner.authority,input));
    assert.equal(saved.kind,'created');
    assert.equal(saved.record.sequence,1);
    assert.equal(saved.record.subject.candidateDigest.hex,identified.value.digest.hex);
    s.close();

    s=good(reopenLocalRun(f.input));
    try{
      const readBack=good(s.getCheckpoint('cp-overlay-512'));
      assert.equal(readBack.subject.candidateDigest.hex,identified.value.digest.hex);

      const view=good(s.recoveryView(owner.authority,{checkpointId:'cp-overlay-512',availableArtifacts:[input.workspace]}));
      assert.equal(view.checkpoint.subject.candidateDigest.hex,identified.value.digest.hex);

      const beforeReject=good(s.inspect());
      const overlay513=buildOverlayManifest(513);
      errorCode(s.writeCheckpoint(owner.authority,{...checkpoint(beforeReject.revision,'cp-overlay-513'),candidateManifest:overlay513}),'INVALID_INPUT');
      assert.equal(good(s.inspect()).revision,beforeReject.revision);
      assert.equal(good(s.inspect()).counts.checkpoints,1);
    }finally{s.close();}
  }finally{f.cleanup();}
});

test('default run without budgets.overlay still rejects 129-file overlay manifest and > 65536-byte checkpoint input with LIMIT_EXCEEDED',()=>{
  const f=fixture({},60000);
  try{
    const s=f.create();
    try{
      const owner=good(s.claim({ownerId:'owner-1',expectedGeneration:0,expectedRevision:0,mode:'active'}));
      const before=good(s.inspect());

      const overlay129=buildOverlayManifest(129);
      errorCode(s.writeCheckpoint(owner.authority,{...checkpoint(before.revision,'cp-overlay-129'),candidateManifest:overlay129}),'LIMIT_EXCEEDED');

      const oversizedBytesManifest=buildOverlayManifest(60,'https://example.invalid/'+'a'.repeat(1200)+'/');
      assert.ok(Buffer.byteLength(JSON.stringify(oversizedBytesManifest))>65536);
      errorCode(s.writeCheckpoint(owner.authority,{...checkpoint(before.revision,'cp-oversized-bytes'),candidateManifest:oversizedBytesManifest}),'LIMIT_EXCEEDED');

      const after=good(s.inspect());
      assert.equal(after.revision,before.revision);
      assert.equal(after.counts.checkpoints,0);
    }finally{s.close();}
  }finally{f.cleanup();}
});

test('STATE_LIMITS.wideCheckpointBytes=8 MiB and overlayCheckpointBounds admit 16,384-entry checkpoint inputs while rejecting 16,385',async ()=>{
  const { OVERLAY_LIMITS, digestArtifactFromMetadata } = await import('@loopwright/core');
  const { STATE_LIMITS, overlayCheckpointBounds } = await import('../src/boundary.js');
  const { checkpointInput } = await import('../src/checkpoint.js');
  const { StateFailure } = await import('../src/errors.js');

  assert.equal(STATE_LIMITS.wideCheckpointBytes,8_388_608);
  const maxOverlay={maxFiles:16_384,maxBytes:OVERLAY_LIMITS.maxMaxBytes} as const;
  assert.deepEqual(overlayCheckpointBounds(maxOverlay),{
    maxBytes:8_388_608,
    nodes:268_288,
    collection:16_385,
  });

  const baseTree:BaseTreeAnchor={objectFormat:'sha256',commitOid:'c'.repeat(64),treeOid:'d'.repeat(64)};
  const sampleDigest={algorithm:'sha256' as const,hex:'e'.repeat(64)};
  const entries16384=Array.from({length:16_384},(_,i)=>{
    const res=digestArtifactFromMetadata(`src/mod-${String(i).padStart(5,'0')}.ts`,{digest:sampleDigest,byteLength:128});
    if(!res.ok)throw new Error('digestArtifactFromMetadata failed');
    return res.value;
  });
  const manifest16384:ArtifactManifest={
    apiVersion:'loopwright.dev/v1alpha1',
    kind:'ArtifactManifest',
    metadata:{id:'candidate'},
    spec:{baseTree,entries:entries16384,deleted:[]},
  };
  const baseCp=checkpoint(0,'cp-overlay-16384');
  const rawInput16384={...baseCp,candidateManifest:manifest16384};
  assert.ok(Buffer.byteLength(JSON.stringify(rawInput16384))>2_097_152,'16,384-entry checkpoint input exceeds old 2 MiB ceiling');

  const validated=checkpointInput(rawInput16384,maxOverlay);
  assert.equal((validated.candidateManifest as ArtifactManifest).spec.entries.length,16_384);

  const extraRes=digestArtifactFromMetadata('src/mod-16384.ts',{digest:sampleDigest,byteLength:128});
  if(!extraRes.ok)throw new Error('digestArtifactFromMetadata failed');
  const manifest16385:ArtifactManifest={
    ...manifest16384,
    spec:{baseTree,entries:[...entries16384,extraRes.value],deleted:[]},
  };
  assert.throws(
    ()=>checkpointInput({...baseCp,candidateManifest:manifest16385},maxOverlay),
    (err:unknown)=>err instanceof StateFailure && err.code==='INVALID_INPUT',
  );
  const manifest16386:ArtifactManifest={
    ...manifest16384,
    spec:{baseTree,entries:[...entries16384,extraRes.value,extraRes.value],deleted:[]},
  };
  assert.throws(
    ()=>checkpointInput({...baseCp,candidateManifest:manifest16386},maxOverlay),
    (err:unknown)=>err instanceof StateFailure && err.code==='LIMIT_EXCEEDED',
  );
});
