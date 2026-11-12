/* global process, Buffer, URL, AbortController, structuredClone, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, appendFileSync, openSync, closeSync, fsyncSync, existsSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { admitTask } from '@loopwright/core';
import { createLocalRun } from '@loopwright/state';
import {checkedRef, canonical, sha, nonce, exclusive, readPrivate, localOwner, monotonic, bindContext, revoke } from './native-context.mjs';
import { NativeLedger, createOfflineLedger, charges } from './native-ledger.mjs';
import { NativeMeter, meterSnapshot, providerShim, mcpShim, processShims, PROVIDER_URL } from './native-guards.mjs';
import { ParentLifecycle } from './lifecycle.mjs';
import { installOfflineBindings, readOriginalState, readPublicSnapshot } from './native-preload.mjs';
import { nativeEntry } from './native-fixtures.mjs';
import { selection, nativeActivationHeld, qualificationMaxima } from './schedule.mjs';

const realPath = resolve('.claude/s04-qualification/budget.json'), realBytes = readFileSync(realPath), original = JSON.parse(JSON.parse(realBytes).qualificationReservations ? checkedRef(JSON.parse(realBytes).qualificationReservations.origin) : realBytes);
const root = mkdtempSync(resolve('.claude/s04-qualification/offline-')), observations = [], owner = localOwner();
const sourceFiles = readdirSync(resolve('packages/controller/qualification')).filter(name => name.endsWith('.mjs')).sort();
const source = Object.fromEntries(sourceFiles.map(name => [name, sha(readFileSync(resolve('packages/controller/qualification', name)))]));
const sourceBodies = Object.fromEntries(sourceFiles.map(name => [name, exclusive(join(root, 'source-' + name + '.bin'), readFileSync(resolve('packages/controller/qualification', name)))]));
const registryPath = resolve('.claude/s04-qualification/offline-fixtures.ndjson');
appendFileSync(registryPath, canonical({ version: 1, root, owner, originalBudgetSha256: sha(realBytes), kind: 'offline-only-no-Docker-network-SDK' }) + '\n', { mode: 0o600 });
const registry = openSync(registryPath, 'r'); try { fsyncSync(registry); } finally { closeSync(registry); }
function evidence(name, value) { const ref = exclusive(join(root, name + '.json'), { version: 1, level: 'offline-only', value }); observations.push({ name, ref }); return value; }
function attempt(action) { try { const value = action(); return { ok: true, value }; } catch (error) { return { ok: false, code: error.message, name: error.name }; } }
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function ledgerFixture(caps = { provider: 2, mcp: 2, containers: 4 }, fault) {
  const directory = mkdtempSync(join(root, 'ledger-')), path = join(directory, 'budget.json'); createOfflineLedger(path, original);
  exclusive(join(directory, 'source-manifest.json'), { version: 1, hashes: source, bodies: sourceBodies });
  const ledger = new NativeLedger(path, fault), context = { runId: 'run-unit', taskId: 'task-unit', dispatchId: 'dispatch-unit', sourceDigest: sha(canonical(source)), image: 'sha256:' + 'a'.repeat(64), leafCutoff: String(monotonic() + 10000n) };
  return { directory, path, ledger, context, reserve: () => ledger.reserve(context, caps) };
}
function stateFixture() {
  const directory = mkdtempSync(join(root, 'state-'));
  let resultOrdinal = 0;
  const task = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract', spec: {
    goal: 'offline guard input', taskpack: 'offline', target: { repository: 'unit/repo', baseRevision: 'base-1', sourceRevision: 'source-1', matrix: null }, scope: { writable: ['packages/**'], protected: [] },
    roles: [{ id: 'builder', adapter: 'pi', provider: 'github-copilot', model: 'unit-model', thinking: 'high', tools: ['read'] }], trustedContext: { revision: 'unit-context', discovery: 'disabled', resources: [] },
    budgets: { wallTimeMs: 10000, totalTokens: 1000, perCallOutputTokens: 20, maxModelCalls: 3, maxConcurrency: 1, maxFormatRepairs: 0, maxImplementationRepairs: 0, maxTransportRetries: 0,
      enforcement: { wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission', formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission' } },
    steps: [{ id: 'build', kind: 'agent', uses: 'unit-handler', roleId: 'builder', dependsOn: [] }], acceptance: { required: ['tests'], checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }] },
  } };
  const good = value => {
    // Authentic live permits stay ONLY in their original caller. Public records remain independently inspectable.
    const saved = value.ok && value.value?.permit ? { ok: true, value: { kind: value.value.kind, revision: value.value.revision, record: value.value.record, originalPermitRetainedInCallerOnly: true } }
      : value.ok && typeof value.value?.inspect === 'function' ? { ok: true, value: { opaqueLocalRunStore: true } } : value;
    exclusive(join(directory, 'original-result-' + (++resultOrdinal) + '.json'), saved);
    assert.equal(value.ok, true, value.ok ? undefined : canonical(value)); if (!value.ok) throw new Error('fixture'); return value.value;
  };
  exclusive(join(directory, 'original-task.json'), task);
  const lock = good(admitTask(task, { admissionId: 'unit-admission', runId: 'run-unit' }));
  const identity = { directory: join(directory, 'state'), storeId: 'unit-store', lock, policy: { version: 1, leaseMs: 1000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 'offline', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: 'unit-context', clockEpoch: 'boot.' + sha(owner.boot).slice(0,32) } };
  exclusive(join(directory, 'original-input.json'), identity);
  const store = good(createLocalRun(identity)), initial = good(store.inspect()), authority = good(store.claim({ ownerId: 'unit-owner', expectedRevision: initial.revision, expectedGeneration: initial.owner.generation, mode: 'active' })).authority;
  const view = good(store.inspect()), descriptor = exclusive(join(directory, 'run.json'), { version: 1, identity });
  return { directory, identity, store, authority, view, descriptor, good, close: () => good(store.close()) };
}
function contextFor(f, patch = {}) {
  return bindContext({ mode: 'offline', runId: f.view.runId, taskId: 'task-unit', dispatchId: 'dispatch-unit', sourceDigest: sha(canonical(source)), image: 'sha256:' + 'a'.repeat(64), identity: { storeId: f.view.storeId, lockHash: f.view.lockHash }, owner: { id: f.view.owner.ownerId, generation: f.view.owner.generation }, basis: f.view.clock.basis,
    workCutoff: String(BigInt(f.view.clock.basis.taskDeadlineMonotonicMs) - 1n), leafCutoff: String(monotonic() + 8000n), signal: new AbortController().signal, cancelled: () => false, providerEndpoint: 'http://127.0.0.1:19080/messages', mcpEndpoint: 'http://127.0.0.1:19081/mcp', executable: '/private/frozen/docker', socket: '/private/frozen/docker.sock', commands: [], ...patch });
}
function command(f, kind = 'create', n = 'a'.repeat(32)) {
  const identity = { nonce: n, name: 'lw-pi-' + n, labels: { 'org.loopwright.nonce': n }, image: 'sha256:' + 'a'.repeat(64) }, environment = { PATH: '/usr/bin:/bin', HOME: f.directory, LANG: 'C' };
  return { kind, identity, environment, argv: ['--config', join(f.directory, 'docker-client'), '--host', 'unix:///private/frozen/docker.sock', kind === 'read' ? 'inspect' : kind, identity.name, identity.image] };
}
after(() => {
  const afterBytes = readFileSync(realPath);
  exclusive(join(root, 'offline-result.json'), { version: 1, owner, source, observations, originalBudgetSha256: sha(realBytes), finalBudgetSha256: sha(afterBytes), nativeBudgetUnchanged: realBytes.equals(afterBytes), nativeSDK: false, Docker: false, services: false, network: false, scope: 'offline-mocks-public-S02-bounded-Node-handshake' });
  assert.ok(realBytes.equals(afterBytes));
});

test('offline: finite reservation retains legacy observations, full caps and opaque once-only meter identity', () => {
  const f = ledgerFixture(), handle = f.reserve(), meter = new NativeMeter(handle), budget = f.ledger.read();
  const copied = attempt(() => new NativeMeter({ ...handle })), repeated = attempt(() => new NativeMeter(handle));
  const prior = attempt(f.reserve);
  evidence('reservation', { directory: f.directory, budget, charges: charges(budget), copied, repeated, prior, initial: meterSnapshot(meter.snapshot()) });
  assert.equal(budget.providerSends, original.providerSends); assert.equal(budget.mcpAttempts, original.mcpAttempts); assert.deepEqual(budget.containers, original.containers);
  assert.deepEqual(charges(budget).held, { provider: 2, mcp: 2, containers: 4 }); assert.equal(copied.ok, false); assert.equal(repeated.ok, false);
  assert.equal(prior.ok, false); assert.match(prior.code, /PRIOR_UNRESOLVED/);
});
test('offline: busy, foreign and torn locks refuse without deletion or new grant', () => {
  const results = [];
  for (const body of ['{', canonical({ version: 1, owner: { pid: 123, birth: 'foreign-fixture', boot: 'foreign-fixture' }, nonce: 'f'.repeat(32) })]) {
    const f = ledgerFixture(); writeFileSync(f.path + '.lock', body, { flag: 'wx', mode: 0o600 }); const before = readFileSync(f.path + '.lock'), returned = attempt(f.reserve), after = readFileSync(f.path + '.lock');
    results.push({ directory: f.directory, returned, before: sha(before), after: sha(after), remains: existsSync(f.path + '.lock') });
  }
  evidence('locks', results); assert.ok(results.every(row => !row.returned.ok && row.before === row.after && row.remains));
});
test('offline: uncertain durable reservation before or after rename survives reopen as blocked full-cap state', () => {
  const results = [];
  for (const point of ['before_commit', 'after_commit']) {
    const f = ledgerFixture(undefined, phase => { if (phase === point) throw new Error('injected-commit-unknown'); });
    const returned = attempt(f.reserve), reopened = new NativeLedger(f.path), read = attempt(() => reopened.read()), nextGrant = attempt(() => reopened.reserve(f.context, { provider: 1, mcp: 1, containers: 1 }));
    const candidates = [f.path, ...readdirSync(f.directory).filter(name => name.startsWith('budget.json.next.')).map(name => join(f.directory,name))].map(path => ({ path, value: JSON.parse(readPrivate(path)) }));
    results.push({ directory: f.directory, point, returned, read, nextGrant, candidates });
  }
  evidence('crash-reopen', results); assert.ok(results.every(row => !row.returned.ok && !row.read.ok && !row.nextGrant.ok && row.candidates.some(candidate => candidate.value.qualificationReservations.entries.some(entry => entry.state === 'held' && entry.caps.containers === 4))));
});
test('offline: global caps and active four cannot be widened, rm alone does not release occupancy', () => {
  const f = ledgerFixture({ provider: 2, mcp: 2, containers: 8 }), handle = f.reserve(), meter = new NativeMeter(handle), attempts = [];
  const container = i => { const token=i.toString(16).padStart(32,'0');return {nonce:token,name:'lw-pi-'+token,labels:{'org.loopwright.nonce':token},image:'sha256:'+'a'.repeat(64)}; };
  for (let i = 0; i < 4; i++) meter.consume('containers',container(i));
  attempts.push(attempt(() => meter.consume('containers',container(4))), attempt(() => meter.removed({ nonce:container(0).nonce, removed:true })), attempt(() => meter.snapshot()));
  const limits=[];
  for (const kind of ['provider','mcp','containers']) {
    const over=structuredClone(original),d=mkdtempSync(join(root,'full-')),caps={provider:0,mcp:0,containers:0};caps[kind]=1;
    if(kind==='provider')over.providerSends=qualificationMaxima.provider;else if(kind==='mcp')over.mcpAttempts=qualificationMaxima.mcp;else over.containers=Array.from({length:qualificationMaxima.containers},(_,index)=>({directory:d,name:'lw-pi-'+index.toString(16).padStart(32,'0'),nonce:index.toString(16).padStart(32,'0'),image:'sha256:'+'a'.repeat(64),syntheticBoundaryOnly:true}));
    createOfflineLedger(join(d,'budget.json'),over);const ledger=new NativeLedger(join(d,'budget.json'));limits.push({kind,returned:attempt(()=>ledger.reserve(f.context,caps)),retained:ledger.read()});
  }
  evidence('caps-active', { attempts,limits }); assert.ok(attempts.every(value => !value.ok));assert.ok(limits.every(row=>!row.returned.ok));assert.match(attempts[0].code,/ACTIVE_LIMIT/);
});
test('offline: exact provider route preserves original options, counts once and denies unsupported routes/caps', () => {
  const s = stateFixture(), f = ledgerFixture({ provider:1,mcp:1,containers:0 }), meter = new NativeMeter(f.reserve()), context = contextFor(s); let calls = 0, sameOptions = false;
  const options = { method:'POST',headers:{},body:Buffer.from('synthetic'),signal:context.signal,redirect:'error' };
  const fetch = providerShim(context,meter,(url,value)=>{ calls++; sameOptions = value === options; return url; });
  try {
    const denied = [attempt(()=>fetch('https://unapproved.invalid/',options)),attempt(()=>fetch(PROVIDER_URL,{...options,method:'GET'}))], returned = fetch(PROVIDER_URL,options), exhausted = attempt(()=>fetch(PROVIDER_URL,options));
    evidence('provider', { denied, returned, exhausted, calls, sameOptions, counts:meterSnapshot(meter.snapshot()) }); assert.ok(denied.every(value=>!value.ok)); assert.equal(returned,context.providerEndpoint); assert.equal(calls,1); assert.equal(sameOptions,true); assert.equal(exhausted.ok,false);
  } finally { s.close(); }
});
test('offline: delayed durable preparation crossing cutoff while abort timer is pending produces zero lower provider/request/process actions', () => {
  const s=stateFixture(),f=ledgerFixture(),meter=new NativeMeter(f.reserve()),abort=new AbortController(),cutoff=String(monotonic()+30n),context=contextFor(s,{signal:abort.signal,leafCutoff:cutoff});let lower=0;
  const timer=setTimeout(()=>abort.abort(),1), preparation = exclusive(join(f.directory,'original-durable-preparation.json'),{cutoff,owner}); pause(60);
  try {
    const provider=attempt(()=>providerShim(context,meter,()=>{lower++;})(PROVIDER_URL,{method:'POST',headers:{},body:Buffer.from('x'),signal:abort.signal,redirect:'error'}));
    const request=attempt(()=>mcpShim(context,meter,()=>{lower++;})({protocol:'http:',hostname:'127.0.0.1',port:'19081',path:'/mcp',method:'POST',agent:false,maxHeaderSize:8192,lookup:()=>{},signal:abort.signal},()=>{}));
    const entry=command(s),processContext=contextFor(s,{signal:abort.signal,leafCutoff:cutoff,commands:[entry]});let durableIntent=null;
    const wrapped=processShims(processContext,meter,{spawn:()=>{lower++;return {pid:123};}},()=>{durableIntent=exclusive(join(f.directory,'original-delayed-process-intent.json'),entry);pause(60);},()=>s.good(s.store.inspect()));
    const processEntry=attempt(()=>wrapped.spawn(processContext.executable,entry.argv,{env:entry.environment}));
    evidence('delayed-preentry',{preparation,durableIntent,cutoff,after:String(monotonic()),abortPending:!abort.signal.aborted,provider,request,processEntry,lower,held:charges(f.ledger.read()).held}); assert.equal(abort.signal.aborted,false); assert.equal(lower,0); assert.equal(provider.ok,false); assert.equal(request.ok,false);assert.equal(processEntry.ok,false);
  } finally {clearTimeout(timer);s.close();}
});
test('offline: MCP post-connect expiry is a counted request with zero authorization/body, preserving original permit in stock caller model', () => {
  const s=stateFixture(),f=ledgerFixture(),meter=new NativeMeter(f.reserve()),context=contextFor(s); let requests=0,authorization=0,bodies=0;
  try {
    const admission={requestId:'unit-request',roleId:'builder',nodeId:'build',attemptId:'unit-attempt',purpose:'task',repair:'none',transportRetryOf:null,requestDigest:{algorithm:'sha256',hex:'a'.repeat(64)},inputUpperBound:10,outputUpperBound:10,totalUpperBound:20,capability:{adapterId:'pi',adapterVersion:'0.0.0',provider:'github-copilot',model:'unit-model',kind:'soft_only',coversAllBillableTokens:false,enforcesOutputBound:false},operationId:'unit-op',targetIdentity:'offline-no-network'};
    exclusive(join(s.directory,'original-reserve-input.json'),{authority:s.authority,admission});s.good(s.store.reserveRequest(s.authority,admission));
    const dispatched=s.good(s.store.authorizeRequestDispatch(s.authority,'unit-request')),permit=dispatched.permit;assert.equal(dispatched.kind,'new_dispatch');
    const request=mcpShim(context,meter,()=>{requests++;return {connect(){const view=s.good(s.store.inspect());if(monotonic()>=BigInt(permit.notAfterMonotonicMs)||view.owner.generation!==permit.generation)throw new Error('ORIGINAL_PERMIT_EXPIRED');authorization++;bodies++;}};});
    const originalOptions={protocol:'http:',hostname:'127.0.0.1',port:'19081',path:'/mcp',method:'POST',agent:false,maxHeaderSize:8192,lookup:()=>{},signal:context.signal};const created=request(originalOptions,()=>{});
    pause(1100);const connected=attempt(()=>created.connect()); evidence('mcp-connect',{requests,authorization,bodies,connected,originalPermitRetainedInCallerOnly:true,counts:meterSnapshot(meter.snapshot()),journal:s.good(s.store.listRequests({limit:100,cursor:null}))}); assert.equal(requests,1);assert.equal(authorization,0);assert.equal(bodies,0);assert.equal(connected.ok,false);
  } finally{s.close();}
});
test('offline: Docker final actual clock follows delayed public inspect and close, never adopting a replacement owner', () => {
  const s=stateFixture(),f=ledgerFixture(),entry=command(s),abort=new AbortController();let calls=0;
  try{
    const cutoff=String(monotonic()+30n),ctx=contextFor(s,{signal:abort.signal,leafCutoff:cutoff,commands:[entry]}),meter=new NativeMeter(f.reserve()),timer=setTimeout(()=>abort.abort(),1);
    const wrapper=processShims(ctx,meter,{spawn:()=>{calls++;return {pid:123};}},()=>{},()=>{const view=readOriginalState(s.descriptor.path,s.descriptor.sha256,ctx);pause(60);return view;});
    const delayed=attempt(()=>wrapper.spawn(ctx.executable,entry.argv,{env:entry.environment}));clearTimeout(timer);
    const before=s.view;s.good(s.store.release(s.authority));const released=s.good(s.store.inspect());s.good(s.store.claim({ownerId:'replacement',expectedRevision:released.revision,expectedGeneration:released.owner.generation,mode:'active'}));
    const fresh=contextFor({...s,view:before},{commands:[entry]}),next=processShims(fresh,meter,{spawn:()=>{calls++;return {pid:123};}},()=>{},()=>s.good(s.store.inspect()));const changed=attempt(()=>next.spawn(fresh.executable,entry.argv,{env:entry.environment}));
    evidence('docker-last-fence',{delayed,changed,calls,abortPending:!abort.signal.aborted,expectedOwner:fresh.owner,actualOwner:s.good(s.store.inspect()).owner});assert.equal(delayed.ok,false);assert.equal(changed.ok,false);assert.equal(calls,0);
  }finally{s.close();}
});
test('offline: wrong Docker socket/image/labels/argv/env and untrusted epoch/signal deny before saved entry', () => {
  const s=stateFixture(),f=ledgerFixture(),entry=command(s),context=contextFor(s,{commands:[entry]}),meter=new NativeMeter(f.reserve());let calls=0;
  try{
    const wrapper=processShims(context,meter,{spawn:()=>{calls++;return {pid:123};}},()=>{},()=>s.good(s.store.inspect()));
    const inputs=[entry.argv.map((v,i)=>i===3?'unix:///wrong':v),[...entry.argv.slice(0,-1),'sha256:'+'b'.repeat(64)],['pull','unapproved'],[...entry.argv,'--label','foreign=true']];
    const denied=inputs.map(argv=>attempt(()=>wrapper.spawn(context.executable,argv,{env:entry.environment})));denied.push(attempt(()=>wrapper.spawn(context.executable,entry.argv,{env:{...entry.environment,HOME:'/wrong'}})));
    const invalidView=structuredClone(s.view);invalidView.clock.basis.clockEpoch='another-boot';const wrong=processShims(context,meter,{spawn:()=>{calls++;return {pid:123};}},()=>{},()=>invalidView);denied.push(attempt(()=>wrong.spawn(context.executable,entry.argv,{env:entry.environment})));
    const abort=new AbortController();abort.abort();denied.push(attempt(()=>revoke(contextFor(s,{signal:abort.signal}),s.view)));
    evidence('docker-denials',{denied,calls});assert.ok(denied.every(value=>!value.ok));assert.equal(calls,0);
  }finally{s.close();}
});
test('offline: post-spawn missing identity and synchronous unknown result retain capacity and prevent replay', () => {
  const s=stateFixture(),f=ledgerFixture(),entry=command(s),context=contextFor(s,{commands:[entry]}),meter=new NativeMeter(f.reserve());let calls=0;
  try{
    const actual={},wrapped=processShims(context,meter,{spawn:()=>{calls++;return actual;}},()=>{},()=>s.good(s.store.inspect()));const returned=wrapped.spawn(context.executable,entry.argv,{env:entry.environment});const snapshot=attempt(()=>meter.snapshot()),again=attempt(()=>wrapped.spawn(context.executable,entry.argv,{env:entry.environment}));
    evidence('post-spawn-unknown',{returnedOriginal:returned===actual,calls,snapshot,again,held:charges(f.ledger.read()).held});assert.equal(returned,actual);assert.equal(calls,1);assert.equal(snapshot.ok,false);assert.equal(again.ok,false);
  }finally{s.close();}
});
test('offline: complete public cursors reject cross-run, stale, duplicate and empty continuation pages',()=>{
  const s=stateFixture();
  try{
    const actual=readPublicSnapshot(s.store),results=[];
    for(const mode of ['foreign','revision','duplicate','empty']){
      const view=structuredClone(s.view);view.counts.requests=2;let reads=0;
      const mock={inspect:()=>({ok:true,value:view}),listRequests:()=>{reads++;const next={storeId:view.storeId,runId:mode==='foreign'?'foreign':view.runId,collection:'requests',revision:view.revision,afterSequence:1};return {ok:true,value:{revision:mode==='revision'?view.revision+1:view.revision,items:reads===1?[{sequence:1}]:mode==='empty'?[]:[{sequence:1}],next:reads===1?next:null}};},listOperations:()=>({ok:true,value:{revision:view.revision,items:[],next:null}}),listCheckpoints:()=>({ok:true,value:{revision:view.revision,items:[],next:null}})};
      results.push({mode,returned:attempt(()=>readPublicSnapshot(mock)),reads});
    }
    evidence('public-cursors',{actual,syntheticInvalidPages:results});assert.ok(results.every(row=>!row.returned.ok));assert.equal(actual.records.requests.length,0);
  }finally{s.close();}
});
test('offline: synchronous process throws and unrelated nested delegation remain unknown with zero fabricated exit',()=>{
  const s=stateFixture(),f=ledgerFixture(),entry=command(s),other=command(s,'create','b'.repeat(32)),context=contextFor(s,{commands:[entry,other]}),meter=new NativeMeter(f.reserve());let lower=0,guards=0;
  try{
    const wrapped=processShims(context,meter,{execCustom:()=>wrapped.spawn(context.executable,other.argv,{env:other.environment}),spawn:()=>{lower++;return {pid:123};}},()=>{guards++;},()=>s.good(s.store.inspect()));
    const nested=attempt(()=>promisify(wrapped.execFile)(context.executable,entry.argv,{env:entry.environment}));
    const g=ledgerFixture(),next=new NativeMeter(g.reserve()),throwing=processShims(context,next,{spawn:()=>{throw new Error('synthetic-sync-throw');}},()=>{},()=>s.good(s.store.inspect())),thrown=attempt(()=>throwing.spawn(context.executable,entry.argv,{env:entry.environment}));
    evidence('delegation-throw',{nested,thrown,lower,guards,nestedCounter:attempt(()=>meter.snapshot()),throwCounter:attempt(()=>next.snapshot())});assert.equal(nested.ok,false);assert.match(nested.code,/REENTRANT/);assert.equal(lower,0);assert.equal(guards,1);assert.equal(thrown.ok,false);
  }finally{s.close();}
});
test('offline: original parent owns pre-module ACK, actual child identity, complete terminal seal and idempotent settlement', async()=>{
  const f=ledgerFixture(),handle=f.reserve(),meter=new NativeMeter(handle),lifecycle=new ParentLifecycle(handle,f.directory),child=await lifecycle.handshake({bindings:true,refundPath:f.path});
  const copied=attempt(()=>f.ledger.settle(handle,{})),proof=lifecycle.seal(meter),first=f.ledger.settle(handle,proof),second=f.ledger.settle(handle,proof),value=f.ledger.read();
  evidence('parent-settlement',{child,copied,first,second,value,charges:charges(value)});assert.equal(child.appStarted,true);assert.ok(child.stdout.includes('"changed":true,"restored":true'));assert.ok(child.stdout.includes('QUALIFICATION_RESERVATION_HANDLE'));assert.equal(copied.ok,false);assert.equal(first,'settled');assert.equal(second,'existing');assert.deepEqual(charges(value).held,{provider:0,mcp:0,containers:0});
});
test('offline: uncertain settlement write retains prior full cap and refuses reopen or another grant',async()=>{
  const f=ledgerFixture(),handle=f.reserve(),meter=new NativeMeter(handle),lifecycle=new ParentLifecycle(handle,f.directory);await lifecycle.handshake();const proof=lifecycle.seal(meter);
  const uncertain=new NativeLedger(f.path,phase=>{if(phase==='after_commit')throw new Error('injected-settlement-unknown');}),returned=attempt(()=>uncertain.settle(handle,proof)),reopened=new NativeLedger(f.path),read=attempt(()=>reopened.read()),grant=attempt(()=>reopened.reserve(f.context,{provider:1,mcp:1,containers:1})),raw=JSON.parse(readPrivate(f.path));
  evidence('settlement-unknown',{returned,read,grant,raw,fullPriorCap:raw.qualificationReservations.entries[0].caps,lockRetained:existsSync(f.path+'.lock')});assert.equal(returned.ok,false);assert.equal(read.ok,false);assert.equal(grant.ok,false);assert.equal(raw.qualificationReservations.entries[0].caps.containers,4);
});
test('offline: altered original trace and source evidence cannot seal or settle a reservation',async()=>{
  const f=ledgerFixture(),handle=f.reserve(),meter=new NativeMeter(handle),lifecycle=new ParentLifecycle(handle,f.directory);await lifecycle.handshake();const proof=lifecycle.seal(meter),id=handle.id,tracePath=join(f.directory,'terminal-trace-'+id+'.json'),sourcePath=join(f.directory,'source-manifest.json');
  const originalTrace=exclusive(join(f.directory,'original-trace-before-negative.bin'),readFileSync(tracePath)),originalSource=exclusive(join(f.directory,'original-source-before-negative.bin'),readFileSync(sourcePath));writeFileSync(tracePath,'{}',{mode:0o600,flush:true});
  const trace=attempt(()=>f.ledger.settle(handle,proof));renameSync(tracePath,tracePath+'.missing-original');
  const missingTraceInput={tracePath,traceExists:existsSync(tracePath),sourceSha256:sha(readFileSync(sourcePath))},missingTrace=attempt(()=>f.ledger.settle(handle,proof));
  writeFileSync(sourcePath,canonical({version:1,hashes:{},bodies:{}}),{mode:0o600,flush:true});const sourceFailure=attempt(()=>lifecycle.seal(meter));
  evidence('terminal-integrity',{originalTrace,originalSource,trace,missingTraceInput,missingTrace,sourceFailure,held:charges(f.ledger.read()).held});assert.equal(trace.ok,false);assert.equal(missingTraceInput.traceExists,false);assert.equal(missingTraceInput.sourceSha256,originalSource.sha256);assert.equal(missingTrace.ok,false);assert.match(missingTrace.code,/ENOENT/);assert.ok(missingTrace.code.includes(tracePath));assert.equal(sourceFailure.ok,false);assert.equal(charges(f.ledger.read()).held.containers,4);
});
test('offline: withheld startup ACK yields no app and cannot settle missing exit/trace evidence',async()=>{
  const f=ledgerFixture(),handle=f.reserve(),meter=new NativeMeter(handle),lifecycle=new ParentLifecycle(handle,f.directory),before=attempt(()=>lifecycle.seal(meter)),child=await lifecycle.handshake({acknowledge:false}),afterSeal=attempt(()=>lifecycle.seal(meter));
  evidence('no-ack',{before,child,afterSeal,held:charges(f.ledger.read()).held});assert.equal(child.appStarted,false);assert.equal(child.exit.code,72);assert.equal(before.ok,false);assert.equal(afterSeal.ok,false);
});
for(const mode of ['callback','custom','spawn','async-error','timeout'])test('offline: original Node handshake '+mode+' fidelity preserves child, bytes, result/error and exact once guard',async()=>{
  const s=stateFixture(),f=ledgerFixture({provider:0,mcp:0,containers:0}),handle=f.reserve(),meter=new NativeMeter(handle),lifecycle=new ParentLifecycle(handle,f.directory),token=nonce(),argv=[fileURLToPath(new URL('./native-handshake-fixture.mjs',import.meta.url)),token];let guards=0,actualResult=null,returnedChild=null;
  const entry={kind:'fixture',argv,environment:{PATH:'/usr/bin:/bin:/usr/sbin',LANG:'C'}},context=contextFor(s,{executable:process.execPath,commands:[entry]}),custom=childProcess.execFile[promisify.custom];
  const wrapped=processShims(context,meter,{execFile:childProcess.execFile,execCustom:custom,spawn:childProcess.spawn},()=>{guards++;},()=>s.good(s.store.inspect()));
  const launch=(file,args,options)=>{
    if(mode==='spawn'){returnedChild=wrapped.spawn(file,args,options);return returnedChild;}
    const opts={env:options.env,encoding:mode==='callback'?'buffer':'utf8',timeout:mode==='timeout'?1500:3000,maxBuffer:8192};
    if(mode==='callback'){returnedChild=wrapped.execFile(file,args,opts,(error,stdout,stderr)=>{actualResult={error:error?{code:error.code,signal:error.signal,killed:error.killed}:null,stdoutBuffer:Buffer.isBuffer(stdout),stdoutSha256:sha(stdout),stderrBytes:stderr.length};});return returnedChild;}
    const promise=promisify(wrapped.execFile)(file,args,opts);returnedChild=promise.child;promise.then(value=>{actualResult={ok:true,stdoutSha256:sha(value.stdout),stderrBytes:value.stderr.length};},error=>{actualResult={ok:false,code:error.code,signal:error.signal,killed:error.killed,stdoutSha256:sha(error.stdout),stderrBytes:error.stderr.length};});return promise;
  };
  try{
    const child=await lifecycle.handshake({token,launch,acknowledge:mode!=='async-error',holdMs:mode==='timeout'?2500:0});if(mode==='custom'||mode==='timeout'||mode==='async-error')await new Promise(resolve=>setTimeout(resolve,0));
    evidence('fidelity-'+mode,{child,actualResult,returnedPid:returnedChild.pid,guards});assert.equal(guards,1);assert.equal(returnedChild.pid,child.actualPid);
    if(mode==='callback'){assert.equal(actualResult.error,null);assert.equal(actualResult.stdoutBuffer,true);}else if(mode==='custom')assert.equal(actualResult.ok,true);else if(mode==='async-error'){assert.equal(actualResult.ok,false);assert.equal(actualResult.code,72);assert.equal(child.appStarted,false);}else if(mode==='timeout'){assert.equal(actualResult.ok,false);assert.equal(actualResult.killed,true);assert.equal(child.exit.signal,'SIGTERM');}
  }finally{s.close();}
});
test('offline: injected targets restore exactly and collision/held native selection cannot activate resources',()=>{
  const s=stateFixture(),f=ledgerFixture(),meter=new NativeMeter(f.reserve()),context=contextFor(s);let underlying=0;
  try{
    const callback=()=>{underlying++;},custom=()=>{underlying++;};Object.defineProperty(callback,promisify.custom,{value:custom});
    const targets={globals:{fetch:callback},childProcess:{execFile:callback,spawn:callback},http:{request:callback},https:{request:callback}},restore=installOfflineBindings(context,meter,()=>{},()=>s.good(s.store.inspect()),()=>{},targets);restore();restore();
    const file=join(f.directory,'existing.json');exclusive(file,{original:true});const before=readFileSync(file),collision=attempt(()=>exclusive(file,{replacement:true}));
    evidence('activation-collision',{native:nativeEntry(),cycle:selection(['--case','cycle','--phase','initial']),held:nativeActivationHeld('cycle'),underlying,collision,before:sha(before),after:sha(readFileSync(file))});
    assert.equal(targets.globals.fetch,callback);assert.equal(targets.childProcess.execFile,callback);assert.equal(targets.http.request,callback);assert.equal(underlying,0);assert.equal(collision.ok,false);assert.deepEqual(readFileSync(file),before);assert.equal(nativeEntry().code,'NATIVE_ACTIVATION_HELD');
  }finally{s.close();}
});
