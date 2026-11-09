/* global process, Buffer */
import { renameSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { canonical, sha, same, nonce, closed, bounded, privateDirectory, readPrivate, checkedRef, syncParent, exclusive, localOwner, monotonic, fail } from './native-context.mjs';
import { terminalProof } from './lifecycle.mjs';
import { withBudgetLock,beginParentTimeFence,parentTimeState,sealParentTimeFence,retainParentTimeReceipt,acknowledgeParentTime,markParentTimeUnknown,markParentTimeUnavailable } from './native-lock.mjs';
import { validateUsage, phaseLimits, allowance, qualificationMaxima } from './schedule.mjs';
import { requireNativeActivation, requireNativePreflightActivation } from './native-activation.mjs';
import { validateTerminalGraph } from './native-terminal.mjs';
import { validateS03Entry, readS03Plan, s03Groups, s03Identity, s03PriorIdentity, s03ActiveIdentity } from './s03-scope.mjs';
import { originalS03Closure } from './s03-closure.mjs';
import { readBridgeLeaf } from './native-bridge.mjs';
const maxima = qualificationMaxima, leafMaxima = { provider: 64, mcp: 128, containers: 64 };
const reservations = new WeakMap();
const observationOwners = new WeakMap();
const preflightTimes = new WeakMap();
export function reservationIdentity(handle) { const value = reservations.get(handle); if (!value) fail('QUALIFICATION_RESERVATION_HANDLE'); return value; }
export function claimReservationObservation(handle, kind) {
  const value = reservationIdentity(handle);
  if (observationOwners.has(handle)) fail('QUALIFICATION_RESERVATION_REPLAY');
  if (!['parent', 'child'].includes(kind)) fail('QUALIFICATION_OBSERVATION_KIND');
  observationOwners.set(handle, kind); return value;
}
export function validateBudget(value) {
  if (value.version !== 1 || !Array.isArray(value.containers)) fail('QUALIFICATION_BUDGET');
  bounded(value.providerSends, 0, maxima.provider); bounded(value.mcpAttempts, 0, maxima.mcp); bounded(value.containers.length, 0, maxima.containers);
  const names = new Set();
  for (const row of value.containers) {
    const token = row?.nonce ?? row?.labels?.['org.loopwright.nonce'];
    if (!row || typeof row.directory !== 'string' || !row.directory.startsWith('/') || row.directory.length > 4096 || !/^[a-f0-9]{32}$/.test(token) || !/^lw-pi-(?:(?:tool|mcp)-)?[a-f0-9]{32}$/.test(row.name) || names.has(row.name) || !/^sha256:[a-f0-9]{64}$/.test(row.image)) fail('QUALIFICATION_BUDGET');
    names.add(row.name);
  }
  const section = value.qualificationReservations;
  closed(section, section?.version===2?['version','mode','revision','entries','origin','timeTransitions']:['version','mode','revision','entries']);
  if (![1,2].includes(section.version) || !['offline','native'].includes(section.mode) || section.mode==='native'&&section.version!==2 || !Array.isArray(section.entries) || section.entries.length > 256) fail('NATIVE_ACTIVATION_HELD');
  if(section.version===2){
    const original=JSON.parse(checkedRef(section.origin));
    if(Object.hasOwn(original,'qualificationReservations')||original.providerSends!==value.providerSends||original.mcpAttempts!==value.mcpAttempts||!same(original.containers,value.containers)||!Array.isArray(section.timeTransitions)||section.timeTransitions.length>256)fail('QUALIFICATION_ORIGIN');
    validateUsage(original.native);validateUsage(value.native);const seen=new Set(),expected=JSON.parse(canonical(original.native));
    for(const row of section.timeTransitions){closed(row,['id','phase','leaf','seconds','receipt']);if(!/^[a-f0-9]{32}$/.test(row.id)||seen.has(row.id)||!Object.hasOwn(phaseLimits,row.phase)||!Number.isFinite(row.seconds)||row.seconds<0||row.seconds>1500)fail('QUALIFICATION_TIME');seen.add(row.id);checkedRef(row.receipt);expected.seconds[row.phase]+=row.seconds;expected.leafSeconds[row.phase+':'+row.leaf]=(expected.leafSeconds[row.phase+':'+row.leaf]??0)+row.seconds;}
    if(!same(expected,value.native))fail('QUALIFICATION_TIME');
  }
  bounded(section.revision, 0, Number.MAX_SAFE_INTEGER); const ids = new Set();
  for (const entry of section.entries) {
    closed(entry, ['id', 'owner', 'context', 'caps', 'state', 'actual', 'seal', ...(entry.state==='allocated_unknown'?['administrative']:[]),...(entry.context?.suite==='s03'?['s03']:[])]);
    if (!/^[a-f0-9]{32}$/.test(entry.id) || ids.has(entry.id) || !['held', 'settled', 'allocated_unknown'].includes(entry.state)) fail('QUALIFICATION_BUDGET'); ids.add(entry.id);
    closed(entry.owner, ['pid', 'birth', 'boot']); bounded(entry.owner.pid, 1, Number.MAX_SAFE_INTEGER);
    closed(entry.context, ['runId', 'taskId', 'dispatchId', 'sourceDigest', 'image', 'leafCutoff', ...(Object.hasOwn(entry.context,'runtimeDigest')?['runtimeDigest']:[]),...(Object.hasOwn(entry.context,'qualificationVersion')?['qualificationVersion','recipeDigest']:[]),...(Object.hasOwn(entry.context,'suite')?['suite']:[])]);
    if(Object.hasOwn(entry.context,'qualificationVersion')&&(entry.context.qualificationVersion!==2||!/^[a-f0-9]{64}$/.test(entry.context.recipeDigest)))fail('QUALIFICATION_RECIPE_VERSION');
    if(section.mode==='native'&&entry.context.qualificationVersion!==2)fail('QUALIFICATION_RECIPE_VERSION');
    if(Object.hasOwn(entry.context,'runtimeDigest')&&!/^[a-f0-9]{64}$/.test(entry.context.runtimeDigest))fail('QUALIFICATION_RUNTIME');
    if (typeof entry.owner.birth !== 'string' || !entry.owner.birth || entry.owner.birth.length > 128 || typeof entry.owner.boot !== 'string' || !entry.owner.boot || entry.owner.boot.length > 256
      || !/^[a-f0-9]{64}$/.test(entry.context.sourceDigest) || !/^sha256:[a-f0-9]{64}$/.test(entry.context.image) || !/^[0-9]{1,32}$/.test(entry.context.leafCutoff)
      || ['runId', 'taskId', 'dispatchId'].some(key => typeof entry.context[key] !== 'string' || !/^[a-z0-9._-]{1,128}$/i.test(entry.context[key]))) fail('QUALIFICATION_BUDGET');
    if (section.mode === 'native' && ![s03Identity, s03PriorIdentity, s03ActiveIdentity].some(identity => same({ runId: entry.context.runId, taskId: entry.context.taskId, dispatchId: entry.context.dispatchId }, identity))) fail('QUALIFICATION_IDENTITY');
    closed(entry.caps, Object.keys(maxima)); for (const key of Object.keys(maxima)) bounded(entry.caps[key], 0, leafMaxima[key]);
    if(Object.hasOwn(entry.context,'suite')){if(entry.context.suite!=='s03'||entry.state==='settled')fail('QUALIFICATION_S03_SCOPE');validateS03Entry(entry);}
    if (entry.state === 'held') { if (entry.actual !== null || entry.seal !== null) fail('QUALIFICATION_BUDGET'); }
    else if(entry.state==='allocated_unknown'){
      if(entry.actual!==null||entry.seal!==null)fail('QUALIFICATION_ADMINISTRATIVE');
      closed(entry.administrative,['original','disposition']);
      const original=JSON.parse(checkedRef(entry.administrative.original)),prior=original.qualificationReservations?.entries.find(row=>row.id===entry.id),disposition=JSON.parse(checkedRef(entry.administrative.disposition));
      if(!prior||prior.state!=='held'||!same(prior,{id:entry.id,owner:entry.owner,context:entry.context,caps:entry.caps,state:'held',actual:null,seal:null,...(entry.context.suite==='s03'?{s03:JSON.parse(checkedRef(entry.s03.audit))}:{})})
        ||disposition.kind!=='qualification-administrative-allocation'||disposition.reservationId!==entry.id||!same(disposition.original,entry.administrative.original)||!same(disposition.caps,entry.caps)||!same(disposition.owner,entry.owner)||disposition.nonrefundable!==true||!((entry.context.suite==='s03'?['PASS','FAIL']:['FAIL']).includes(disposition.originalOutcome))||disposition.actual!=='UNKNOWN'||disposition.originalSeal!=='ABSENT')fail('QUALIFICATION_ADMINISTRATIVE');
      checkedRef(disposition.closure);checkedRef(disposition.approval);
    }
    else {
      closed(entry.actual, Object.keys(maxima)); for (const key of Object.keys(maxima)) bounded(entry.actual[key], 0, entry.caps[key]); closed(entry.seal, ['digest', 'ref']);
      if (!/^[a-f0-9]{64}$/.test(entry.seal.digest)) fail('QUALIFICATION_BUDGET');
      const proof = JSON.parse(checkedRef(entry.seal.ref));
      if (proof.digest !== entry.seal.digest || proof.reservationId !== entry.id || !same(proof.actual, entry.actual) || !same(proof.owner, entry.owner) || !same(proof.context, entry.context) || !Array.isArray(proof.refs) || proof.refs.length < 6 || proof.refs.length > 195
        || proof.digest !== sha(canonical({ refs: proof.refs, actual: proof.actual, reservationId: proof.reservationId }))) fail('QUALIFICATION_BUDGET');
      for (const ref of proof.refs) checkedRef(ref);
      if(section.mode==='native'){
        if(!proof.nativeGraph||proof.nativeGraph.binding.reservationId!==entry.id||proof.nativeGraph.binding.recipeDigest!==entry.context.recipeDigest)fail('QUALIFICATION_NATIVE_TERMINAL');
        validateTerminalGraph(proof.nativeGraph.ref,proof.nativeGraph.binding,proof.nativeGraph.roots);
        const recipe=readBridgeLeaf(proof.nativeGraph.recipe);if(recipe.mode!=='native'||sha(canonical(recipe))!==entry.context.recipeDigest)fail('QUALIFICATION_RECIPE_VERSION');
      }
      const source = JSON.parse(checkedRef(proof.refs[0])); if (sha(canonical(source.hashes)) !== entry.context.sourceDigest || Object.keys(source.hashes).length > 128 || !Object.keys(source.hashes).length) fail('QUALIFICATION_SOURCE_CHANGED');
      for (const [name, digest] of Object.entries(source.hashes)) if (sha(checkedRef(source.bodies[name])) !== digest) fail('QUALIFICATION_SOURCE_CHANGED');
      if(entry.context.runtimeDigest){if(sha(canonical(source.appBindings))!==entry.context.runtimeDigest)fail('QUALIFICATION_RUNTIME');for(const [path,digest] of Object.entries(source.appBindings))if(sha(checkedRef(source.appBodies[path]))!==digest)fail('QUALIFICATION_RUNTIME');}
      const counters = JSON.parse(checkedRef(proof.refs[1])), trace = JSON.parse(checkedRef(proof.refs[2]));
      if (!same(counters.actual, entry.actual) || counters.reservationId !== entry.id || trace.reservationId !== entry.id || !Array.isArray(trace.trace) || trace.trace.length > 1024) fail('QUALIFICATION_TERMINAL_PROOF');
      for (const key of Object.keys(maxima)) if (trace.trace.filter(row => row.kind === key).length !== entry.actual[key]) fail('QUALIFICATION_TERMINAL_PROOF');
    }
  }
  charges(value); return value;
}
export function charges(value) {
  const legacy = { provider: value.providerSends, mcp: value.mcpAttempts, containers: value.containers.length }, held = { provider: 0, mcp: 0, containers: 0 }, settled = { ...held }, allocated = { ...held };
  for (const entry of value.qualificationReservations.entries) for (const key of Object.keys(maxima)) (entry.state === 'held' ? held : entry.state==='allocated_unknown'?allocated:settled)[key] += entry.state === 'settled' ? entry.actual[key] : entry.caps[key];
  const upper = {}; for (const key of Object.keys(maxima)) { upper[key] = legacy[key] + held[key] + settled[key] + allocated[key]; if (upper[key] > maxima[key]) fail('QUALIFICATION_LIMIT'); }
  return { legacy, held, settled, allocated, upper };
}
export function createOfflineLedger(path, original) {
  privateDirectory(dirname(path)); if (original.qualificationReservations) fail('QUALIFICATION_EXISTING_RESERVATIONS');
  const value = JSON.parse(canonical(original)); value.qualificationReservations = { version: 1, mode: 'offline', revision: 0, entries: [] }; validateBudget(value); exclusive(path, value); return path;
}
/** Qualification ledger; original native mutations require live activation and original handles. */
export class NativeLedger {
  /** @type {string} */ path;
  /** @type {ReturnType<typeof localOwner>} */ owner;
  /** @type {(stage:string)=>void} */ fault;
  /** @type {object|null} */ activation;
  /** @type {object|null} */ timeHandle=null;
  constructor(path, fault = () => {}, activation = null) { privateDirectory(dirname(path)); Object.defineProperty(this,'path',{value:path,enumerable:true,writable:false,configurable:false}); Object.defineProperty(this,'owner',{value:Object.freeze(localOwner()),enumerable:true,writable:false,configurable:false}); this.fault = fault; this.activation=activation; }
  read() { if (existsSync(this.path + '.lock')) fail('QUALIFICATION_LOCK_HELD'); return validateBudget(JSON.parse(readPrivate(this.path))); }
  #mutate(action, purpose='work') {
    return withBudgetLock(this.path,this.owner,fence=>{
      const token=fence.token,before = readPrivate(this.path), value = validateBudget(JSON.parse(before)), next = JSON.parse(canonical(value));
      if(value.qualificationReservations.mode==='native')requireNativeActivation(this.activation);
      const result = action(next); next.qualificationReservations.revision++; validateBudget(next);
      const temporary = this.path + '.next.' + token; fence.uncertain();
      exclusive(this.path + '.transition.' + token, { version: 1, owner: this.owner, nonce: token, before: sha(before), proposed: sha(canonical(next) + '\n'), caps: next.qualificationReservations.entries.map(entry => ({ id: entry.id, caps: entry.caps })) });
      exclusive(temporary, next); this.fault('before_commit');
      if (sha(readPrivate(this.path)) !== sha(before)) fail('QUALIFICATION_LEDGER_CHANGED');
      renameSync(temporary, this.path); syncParent(this.path); this.fault('after_commit');
      if (!same(JSON.parse(readPrivate(this.path)), next)) fail('QUALIFICATION_COMMIT_UNKNOWN');
      exclusive(this.path + '.committed.' + token, { version: 1, nonce: token, digest: sha(readPrivate(this.path)) }); fence.confirmed();
      return { result, value: next };
    },this.timeHandle??null,purpose);
  }
  migrateCopied(origin) {
    const bytes=checkedRef(origin),original=JSON.parse(bytes);
    if(Object.hasOwn(original,'qualificationReservations'))fail('QUALIFICATION_ORIGIN');
    return this.#mutate(next=>{
      if(next.qualificationReservations.version!==1||next.qualificationReservations.entries.length)fail('QUALIFICATION_MIGRATION_STATE');
      const legacy=JSON.parse(canonical(next));delete legacy.qualificationReservations;
      if(!same(legacy,original))fail('QUALIFICATION_ORIGIN');
      next.qualificationReservations={...next.qualificationReservations,version:2,origin,timeTransitions:[]};return 'migrated';
    }).result;
  }
  /** Deliberately unreachable without the separately held parent activation. No actual migration runs on import. */
  migrateHeldNative(activation,origin){
    requireNativeActivation(activation);
    const originalBytes=checkedRef(origin),original=JSON.parse(originalBytes);
    if(Object.hasOwn(original,'qualificationReservations')||!original.native)fail('QUALIFICATION_ORIGIN');
    validateUsage(original.native);
    return withBudgetLock(this.path,this.owner,fence=>{
      const before=readPrivate(this.path);if(sha(before)!==sha(originalBytes))fail('QUALIFICATION_ORIGIN');
      const next={...JSON.parse(canonical(original)),qualificationReservations:{version:2,mode:'native',revision:0,entries:[],origin,timeTransitions:[]}};
      validateBudget(next);fence.uncertain();
      const temporary=this.path+'.next.'+fence.token;
      exclusive(this.path+'.transition.'+fence.token,{version:2,kind:'native-migration',owner:this.owner,nonce:fence.token,before:sha(before),proposed:sha(canonical(next)+'\n'),origin});
      exclusive(temporary,next);this.fault('before_commit');
      if(sha(readPrivate(this.path))!==sha(before))fail('QUALIFICATION_LEDGER_CHANGED');
      renameSync(temporary,this.path);syncParent(this.path);this.fault('after_commit');
      if(!same(JSON.parse(readPrivate(this.path)),next))fail('QUALIFICATION_COMMIT_UNKNOWN');
      exclusive(this.path+'.committed.'+fence.token,{version:2,nonce:fence.token,digest:sha(readPrivate(this.path))});fence.confirmed();this.activation=activation;return 'migrated';
    },this.timeHandle??null);
  }
  recordTime(input) {
    return this.#mutate(next=>{
      if(next.qualificationReservations.version!==2)fail('QUALIFICATION_MIGRATION_REQUIRED');
      const prior=next.qualificationReservations.timeTransitions.find(row=>row.id===input.id);
      if(prior){if(!same(prior,input))fail('QUALIFICATION_TIME_CONFLICT');return 'existing';}
      next.qualificationReservations.timeTransitions.push(input);
      next.native.seconds[input.phase]+=input.seconds;
      const key=input.phase+':'+input.leaf;next.native.leafSeconds[key]=(next.native.leafSeconds[key]??0)+input.seconds;
      return 'recorded';
    },'time').result;
  }
  beginCopiedParentTime(info,started=monotonic()){
    if(resolve(this.path)===resolve('.claude/s04-qualification/budget.json'))fail('NATIVE_ACTIVATION_HELD');
    return this.#beginParentTime(info,started);
  }
  beginHeldParentTime(activation,info,started,bootstrap=null){requireNativeActivation(activation);this.activation=activation;return this.#beginParentTime(info,started,bootstrap);}
  /** @param {object|null} [bootstrap] */
  #beginParentTime(info,started,bootstrap=null){
    const record={id:nonce(),phase:typeof info.phase==='string'?info.phase:null,leaf:typeof info.leaf==='string'?info.leaf:null,directory:typeof info.directory==='string'?info.directory:null,startedMonotonicMs:String(started)};
    try{this.timeHandle=beginParentTimeFence(this.path,this.owner,record,bootstrap);return this.timeHandle;}
    catch(error){if(!existsSync(this.path+'.parent-time-pending.json'))markParentTimeUnavailable(this.path);throw error;}
  }
  completeParentTime(handle,outcome,fault=()=>{}){
    const original=parentTimeState(handle);
    if(original.state==='closed'){
      const saved=JSON.parse(checkedRef(original.receipt));checkedRef(original.ack);
      if(!same(saved.outcome,outcome))fail('QUALIFICATION_PARENT_TIME_CONFLICT');return {state:'existing',receipt:original.receipt,ack:original.ack};
    }
    try{
      sealParentTimeFence(handle,null);
      const record=original.record;privateDirectory(record.directory);
      const seconds=Number(monotonic()-BigInt(record.startedMonotonicMs))/1000;
      if(!Number.isFinite(seconds)||seconds<0||!Object.hasOwn(phaseLimits,record.phase)||!['cycle','repair',...Object.keys(s03Groups).map(g=>'s03-'+g)].includes(record.leaf)||record.leaf.startsWith('s03-')&&record.phase!=='finalPi')fail('QUALIFICATION_PARENT_TIME_INPUT');
      fault('before_elapsed_write');
      const receipt=exclusive(join(record.directory,'native-parent-elapsed-'+record.id+'.json'),{version:3,commandId:record.id,pending:original.pending,startedMonotonicMs:record.startedMonotonicMs,phase:record.phase,leaf:record.leaf,seconds,outcome:JSON.parse(canonical(outcome)),fullReservationRetained:outcome.error!==null||record.leaf.startsWith('s03-')});
      fault('after_elapsed_write');retainParentTimeReceipt(handle,receipt);
      const value=JSON.parse(readPrivate(this.path));
      if(value.qualificationReservations?.version!==2)fail('QUALIFICATION_PARENT_TIME_MIGRATION_REQUIRED');
      const transition={id:record.id,phase:record.phase,leaf:record.leaf,seconds,receipt};fault('before_time_write');
      this.recordTime(transition);fault('after_time_write');
      if(record.leaf.startsWith('s03-')){
        const current=JSON.parse(readPrivate(this.path)),entry=current.qualificationReservations.entries.find(e=>e.context.suite==='s03'&&same(readS03Plan(e.s03.plan).timeIntent,original.pending));
        const maxSeconds=['s03-recovery','s03-limits'].includes(record.leaf)?300:120;
        const hard=entry?BigInt(readS03Plan(entry.s03.plan).clock.hardCutoff):BigInt(record.startedMonotonicMs)+BigInt(maxSeconds*1000);
        if(seconds>maxSeconds||monotonic()>=hard)fail('QUALIFICATION_S03_PARENT_TIME_LIMIT');
      }
      const ack=acknowledgeParentTime(handle,transition,sha(readPrivate(this.path)),fault);this.timeHandle=null;return {state:'recorded',receipt,ack};
    }catch(error){markParentTimeUnknown(handle,error.message);throw error;}
  }
  /** @param {object|null} [bootstrap] */
  beginCopiedPreflightTime(info,started=monotonic(),bootstrap=null){
    if(resolve(this.path)===resolve('.claude/s04-qualification/budget.json'))fail('NATIVE_PREFLIGHT_ACTIVATION_HELD');
    return this.#beginPreflightTime(info,started,'copy',bootstrap);
  }
  /** @param {object|null} [bootstrap] */
  beginHeldPreflightTime(activation,info,started=monotonic(),bootstrap=null){requireNativePreflightActivation(activation);return this.#beginPreflightTime(info,started,'native',bootstrap);}
  #beginPreflightTime(info,started,mode,bootstrap){
    if(info.phase!=='initial'||!['image-preflight','derived-image-build'].includes(info.leaf))fail('QUALIFICATION_PREFLIGHT_PHASE');
    const handle=this.#beginParentTime(info,started,bootstrap);preflightTimes.set(handle,{ledger:this,mode,outcome:null,original:null,available:null,lifecycleStarted:false,commandsAttempted:0,closedCommands:[]});return handle;
  }
  beginOriginalPreflightLifecycle(activation,handle){requireNativePreflightActivation(activation);this.#lifecycle(handle,false);}
  beginCopiedPreflightLifecycle(handle){if(preflightTimes.get(handle)?.mode!=='copy')fail('QUALIFICATION_PREFLIGHT_HANDLE');this.#lifecycle(handle,false);}
  noteOriginalPreflightCommand(activation,handle){requireNativePreflightActivation(activation);this.#lifecycle(handle,true);}
  noteCopiedPreflightCommand(handle){if(preflightTimes.get(handle)?.mode!=='copy')fail('QUALIFICATION_PREFLIGHT_HANDLE');this.#lifecycle(handle,true);}
  closeOriginalPreflightCommand(activation,handle,ref){requireNativePreflightActivation(activation);this.#closedCommand(handle,ref);}
  closeCopiedPreflightCommand(handle,ref){if(preflightTimes.get(handle)?.mode!=='copy')fail('QUALIFICATION_PREFLIGHT_HANDLE');this.#closedCommand(handle,ref);}
  #closedCommand(handle,ref){
    const data=preflightTimes.get(handle),state=parentTimeState(handle);if(!data||data.ledger!==this||state.state!=='running'||data.commandsAttempted!==data.closedCommands.length+1)fail('QUALIFICATION_PREFLIGHT_LIFECYCLE');
    const ordinal=data.closedCommands.length,record=JSON.parse(checkedRef(ref));
    if(ref.path!==join(state.record.directory,'cli-'+ordinal+'-exit.json')||record.version!==1||record.closedObserved!==true||record.error!==null||!record.registration||!record.intent||record.unretainedStdout!==0||record.unretainedStderr!==0
      ||!record.owner||record.owner.pid!==record.pid||!record.exit||record.exit.signal!==null||!Number.isSafeInteger(record.exit.code)||record.exit.code<0||record.exit.code>255)fail('QUALIFICATION_PREFLIGHT_CLI_UNKNOWN');
    const registered=JSON.parse(checkedRef(record.registration)),intent=JSON.parse(checkedRef(record.intent));
    if(registered.pid!==record.pid||!same(registered.owner,record.owner)||!same(registered.parent,this.owner)||!same(registered.intent,record.intent)||!same(intent.parent,this.owner))fail('QUALIFICATION_PREFLIGHT_CLI_UNKNOWN');
    for(const stream of [record.stdout,record.stderr]){if(!stream||typeof stream.path!=='string'||!Number.isSafeInteger(stream.byteLength)||!/^[a-f0-9]{64}$/.test(stream.sha256))fail('QUALIFICATION_PREFLIGHT_CLI_UNKNOWN');}
    data.closedCommands.push(ref);
  }
  #lifecycle(handle,command){
    const data=preflightTimes.get(handle);if(!data||data.ledger!==this||parentTimeState(handle).state!=='running')fail('QUALIFICATION_PREFLIGHT_HANDLE');
    if(command){if(data.commandsAttempted!==data.closedCommands.length)fail('QUALIFICATION_PREFLIGHT_LIFECYCLE');if(!data.lifecycleStarted)fail('QUALIFICATION_PREFLIGHT_LIFECYCLE');data.commandsAttempted++;}
    else{if(data.lifecycleStarted)fail('QUALIFICATION_PREFLIGHT_LIFECYCLE');data.lifecycleStarted=true;}
  }
  preparePreflightTime(handle){
    const data=preflightTimes.get(handle),state=parentTimeState(handle);
    if(!data||data.ledger!==this||state.state!=='running'||data.original)fail('QUALIFICATION_PARENT_TIME_PENDING');
    privateDirectory(state.record.directory);
    const bytes=readPrivate(this.path),value=JSON.parse(bytes.toString());
    data.original=exclusive(join(state.record.directory,'preflight-budget-original-'+state.record.id+'.bin'),bytes);
    if(Object.hasOwn(value,'qualificationReservations'))validateBudget(value);
    data.available=allowance(value.native,'initial',state.record.leaf,state.record.leaf==='derived-image-build'?120:60);
    const deadline=BigInt(state.record.startedMonotonicMs)+BigInt(Math.floor(data.available*1000));
    if(monotonic()>=deadline)fail('QUALIFICATION_PREFLIGHT_EXPIRED');
    return {original:data.original,availableSeconds:data.available,deadlineMonotonicMs:String(deadline)};
  }
  readPreparedPreflightTime(handle){
    const data=preflightTimes.get(handle),state=parentTimeState(handle);
    if(!data||data.ledger!==this||state.state!=='running'||!data.original||data.available===null)fail('QUALIFICATION_PREFLIGHT_HANDLE');
    return {original:data.original,availableSeconds:data.available,deadlineMonotonicMs:String(BigInt(state.record.startedMonotonicMs)+BigInt(Math.floor(data.available*1000)))};
  }
  /** @param {(stage:string)=>void} [fault] */
  completeCopiedPreflightTime(handle,outcome,fault=()=>{}){
    if(preflightTimes.get(handle)?.mode!=='copy')fail('QUALIFICATION_PREFLIGHT_HANDLE');
    return this.#completePreflightTime(handle,outcome,fault);
  }
  completeHeldPreflightTime(activation,handle,outcome){requireNativePreflightActivation(activation);return this.#completePreflightTime(handle,outcome,()=>{});}
  #completePreflightTime(handle,outcome,fault){
    const data=preflightTimes.get(handle),state=parentTimeState(handle),outcomeBytes=canonical(outcome);
    if(!data||data.ledger!==this)fail('QUALIFICATION_PREFLIGHT_HANDLE');
    if(data.outcome!==null&&data.outcome!==outcomeBytes)fail('QUALIFICATION_PARENT_TIME_CONFLICT');
    data.outcome=outcomeBytes;
    if(state.state==='closed'){checkedRef(state.receipt);checkedRef(state.ack);return {state:'existing',receipt:state.receipt,ack:state.ack};}
    try{
      sealParentTimeFence(handle,null);privateDirectory(state.record.directory);
      const seconds=Number(monotonic()-BigInt(state.record.startedMonotonicMs))/1000;
      if(!Number.isFinite(seconds)||seconds<0)fail('QUALIFICATION_PARENT_TIME_INPUT');
      fault('before_elapsed_write');
      const receipt=exclusive(join(state.record.directory,'preflight-elapsed-'+state.record.id+'.json'),{version:4,commandId:state.record.id,pending:state.pending,startedMonotonicMs:state.record.startedMonotonicMs,phase:'initial',leaf:state.record.leaf,seconds,outcome:JSON.parse(outcomeBytes),originalLifecycle:{registered:data.lifecycleStarted,commandsAttempted:data.commandsAttempted,knownPrecommandRefusal:outcome.error!==null&&data.lifecycleStarted&&data.commandsAttempted===0,closedCommands:data.closedCommands,knownCompletedReadFailure:outcome.error!==null&&data.lifecycleStarted&&data.commandsAttempted>0&&data.closedCommands.length===data.commandsAttempted},originalBudget:data.original,availableSeconds:data.available});
      fault('after_elapsed_write');retainParentTimeReceipt(handle,receipt);
      if(!data.original||data.available===null)fail('QUALIFICATION_PREFLIGHT_PREPARATION_UNKNOWN');
      const original=checkedRef(data.original),next=JSON.parse(original.toString());validateUsage(next.native);
      if(Object.hasOwn(next,'qualificationReservations'))validateBudget(next);
      next.native.seconds.initial+=seconds;next.native.leafSeconds['initial:'+state.record.leaf]=(next.native.leafSeconds['initial:'+state.record.leaf]??0)+seconds;validateUsage(next.native);
      if(Object.hasOwn(next,'qualificationReservations')){
        next.qualificationReservations.revision++;
        next.qualificationReservations.timeTransitions.push({id:state.record.id,phase:'initial',leaf:state.record.leaf,seconds,receipt});validateBudget(next);
      }
      const proposed=Buffer.from(canonical(next)+'\n'),transition={id:state.record.id,phase:'initial',leaf:state.record.leaf,seconds,receipt,before:data.original,proposed:{byteLength:proposed.length,sha256:sha(proposed)}};
      withBudgetLock(this.path,this.owner,fence=>{
        fence.uncertain();fault('before_transition_write');
        exclusive(this.path+'.transition.'+state.record.id,{version:3,kind:'preflight-time',owner:this.owner,...transition});fault('after_transition_write');
        const temporary=this.path+'.next.'+state.record.id;exclusive(temporary,proposed);fault('before_budget_cas');
        if(sha(readPrivate(this.path))!==data.original.sha256)fail('QUALIFICATION_LEDGER_CHANGED');
        fault('before_budget_rename');renameSync(temporary,this.path);syncParent(this.path);fault('after_budget_rename');
        if(!readPrivate(this.path).equals(proposed))fail('QUALIFICATION_COMMIT_UNKNOWN');
        fault('before_committed_write');exclusive(this.path+'.committed.'+state.record.id,{version:3,id:state.record.id,receipt,before:data.original,proposed:transition.proposed});fault('after_committed_write');fence.confirmed();
      },handle,'time');
      if(seconds>data.available)fail('QUALIFICATION_PREFLIGHT_TIME_LIMIT');
      if(outcome.error!==null&&!(data.lifecycleStarted&&data.commandsAttempted===data.closedCommands.length))fail('QUALIFICATION_PREFLIGHT_OUTCOME_UNKNOWN');
      const ack=acknowledgeParentTime(handle,transition,sha(proposed),fault);this.timeHandle=null;return {state:'recorded',receipt,ack};
    }catch(error){markParentTimeUnknown(handle,error.message);throw error;}
  }
  reserve(context, caps, s03Plan=null) {
    const id = nonce(), owner = this.owner;
    const { value } = this.#mutate(next => {
      closed(caps, Object.keys(maxima)); for (const key of Object.keys(maxima)) bounded(caps[key], 0, leafMaxima[key]);
      if (!same(localOwner(), owner)) fail('QUALIFICATION_OWNER');
      if (context.suite !== 's03' ? next.qualificationReservations.mode === 'native' : true) {
        if (!same({ runId: context.runId, taskId: context.taskId, dispatchId: context.dispatchId }, s03ActiveIdentity)) fail('QUALIFICATION_IDENTITY');
      }
      if (next.qualificationReservations.entries.some(entry => entry.state === 'held')) fail('QUALIFICATION_PRIOR_UNRESOLVED');
      const entry={ id, owner, context, caps: { ...caps }, state: 'held', actual: null, seal: null };
      if(context.suite==='s03'){const plan=readS03Plan(s03Plan);if(!same(plan.caps,caps)||!same(plan.owner,owner))fail('QUALIFICATION_S03_SCOPE');entry.s03={plan:s03Plan,events:[],occupants:[]};}
      next.qualificationReservations.entries.push(entry);
    });
    const entry = value.qualificationReservations.entries.find(entry => entry.id === id), handle = Object.freeze({ id });
    reservations.set(handle, Object.freeze({ ledger: this.path, ...(value.qualificationReservations.mode==='native'?{observationMode:'native'}:{}), entry: JSON.parse(canonical(entry)) })); return handle;
  }
  /** Original-owner full conservative qualification allocation; never a settlement/refund or S02 write. */
  allocateS03(handle,closure){
    const original=reservationIdentity(handle);if(original.ledger!==this.path||original.entry.context.suite!=='s03'||!same(localOwner(),original.entry.owner))fail('QUALIFICATION_S03_CLOSURE');
    return this.#mutate(next=>{
      const entry=next.qualificationReservations.entries.find(row=>row.id===handle.id);if(!entry||entry.state!=='held'||!same(entry.caps,original.entry.caps))fail('QUALIFICATION_S03_CLOSURE');
      const data=originalS03Closure(closure,this.path,entry);if(data.mode!==(original.observationMode??'offline'))fail('QUALIFICATION_S03_CLOSURE');const plan=readS03Plan(entry.s03.plan),audit=exclusive(join(plan.directory,'original-scope-audit.json'),entry.s03);
      const disposition=exclusive(join(plan.directory,'full-allocation.json'),{version:1,kind:'qualification-administrative-allocation',reservationId:entry.id,original:data.original,caps:entry.caps,owner:entry.owner,nonrefundable:true,originalOutcome:data.result.code===0?'PASS':'FAIL',actual:'UNKNOWN',originalSeal:'ABSENT',closure:data.ref,approval:data.approval});
      entry.state='allocated_unknown';entry.actual=null;entry.seal=null;entry.administrative={original:data.original,disposition};entry.s03={plan:entry.s03.plan,audit};return {state:'allocated_unknown',disposition,closure:data.ref};
    }).result;
  }
  settle(handle, proof) {
    const original = reservationIdentity(handle), sealed = terminalProof(proof);
    if(original.observationMode==='native'&&!sealed.nativeGraph)fail('QUALIFICATION_NATIVE_TERMINAL');
    if (original.ledger !== this.path || original.entry.owner.pid !== process.pid || !same(localOwner(), original.entry.owner) || sealed.reservationId !== handle.id || !same(sealed.owner, original.entry.owner) || !same(sealed.context, original.entry.context)) fail('QUALIFICATION_SETTLEMENT_AUTHORITY');
    return this.#mutate(next => {
      const entry = next.qualificationReservations.entries.find(entry => entry.id === handle.id); if (!entry || !same(entry.caps, original.entry.caps)) fail('QUALIFICATION_SETTLEMENT_IDENTITY');
      if(entry.state==='allocated_unknown')fail('QUALIFICATION_ADMINISTRATIVE_FINAL');
      if (entry.state === 'settled') { if (entry.seal.digest !== sealed.digest || !same(entry.actual, sealed.actual)) fail('QUALIFICATION_SETTLEMENT_CONFLICT'); return 'existing'; }
      entry.state = 'settled'; entry.actual = sealed.actual; entry.seal = { digest: sealed.digest, ref: sealed.sealRef }; return 'settled';
    }).result;
  }
}
/** Copied observation only. These planes never become a grant or a write to the actual native ledger. */
export function observeCopiedReservations(path){
  if(resolve(path)===resolve('.claude/s04-qualification/budget.json'))fail('NATIVE_ACTIVATION_HELD');
  const ledger=new NativeLedger(path),value=ledger.read(),planes=charges(value);
  return {version:1,capacityGrant:'none',unknownReservationRetention:'full',...planes,source:{path,byteLength:readPrivate(path).length,sha256:sha(readPrivate(path))}};
}
