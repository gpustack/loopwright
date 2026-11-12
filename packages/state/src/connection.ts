import { DatabaseSync as Database, type SQLInputValue, type SQLOutputValue, type StatementSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { addMono, canonical, checkedAdd, enumeration, equal, freeze, hash, id, identity, identityBody, integer, mono, record, text } from './boundary.js';
import { clockBasis, clockSample, clockValid, makeBasis, project, systemClock, type ClockSource } from './clock.js';
import { attempt, fail, StateFailure, type StateErrorCode } from './errors.js';
import { storedRequest, storedOperation, validateLinks } from './admission.js';
import { storedCheckpoint } from './checkpoint.js';
import { summaries, type Data } from './model.js';
import { currentEngine, DDL, engineMatches, expectedSchema, PROFILE, schemaIdentity } from './schema.js';
import type { Authority, ClockSample, LocalRunIdentity, RunView } from './types.js';

type Row=Record<string,SQLOutputValue>;
type WriteRow=Record<string,SQLInputValue>;
export type BoundaryEvent={readonly phase:string;readonly storeId:string;readonly runId:string;readonly generation:number;readonly revision:number};
export type Dependencies={readonly clock?:ClockSource;readonly onBoundary?:(event:BoundaryEvent)=>void};
export type ClaimGuard={expectedGeneration:number;expectedRevision:number};
export function nativeFailure(error:unknown):StateFailure {
  if(error instanceof StateFailure)return error;
  const code=error!==null&&typeof error==='object'&&'errcode'in error&&typeof error.errcode==='number'?error.errcode&255:0;
  const mapped:StateErrorCode=code===5||code===6?'STORE_BUSY':code===13?'STORE_FULL':code===11||code===26?'STORE_CORRUPT':'STORE_UNAVAILABLE';
  return new StateFailure(mapped);
}
function parse(raw:unknown,max:number):unknown {
  if(typeof raw!=='string'||Buffer.byteLength(raw)>max)fail('STORE_CORRUPT');
  try{const value:unknown=JSON.parse(raw);if(canonical(value)!==raw)fail('STORE_CORRUPT');return value;}catch{fail('STORE_CORRUPT');}
}
function numberColumn(row:Row,name:string):number {return integer(row[name],`/${name}`);}
function stateHash(row:WriteRow):string {return hash('run-record',row).hex;}
function runRow(data:Data):WriteRow {
  const row:WriteRow={singleton:1,run_id:data.identity.lock.spec.runId,identity_json:canonical(data.identity),identity_digest:data.identityDigest.hex,
    started_at_ms:data.startedAtMs,deadline_ms:data.deadlineMs,revision:data.revision,generation:data.owner.generation,
    owner_id:data.owner.ownerId,owner_nonce:data.owner.nonce,owner_mode:data.owner.mode,lease_until_ms:data.owner.leaseUntilMs,
    lease_granted_monotonic_ms:data.owner.leaseGrantedMonotonicMs,lease_until_monotonic_ms:data.owner.leaseUntilMonotonicMs,
    clock_basis_json:canonical(data.basis),clock_json:canonical({...data.last,status:'trusted'}),ledger_json:canonical(data.ledger),ledger_root:data.ledgerRoot.hex,record_counts_json:canonical(data.counts)};
  return {...row,record_digest:stateHash(row)};
}
function insert(db:Database,table:'store_meta'|'run',row:WriteRow):void {
  const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
}
function requireHeader(db:Database):void {
  const version=db.prepare('PRAGMA user_version').get()?.user_version;
  const app=db.prepare('PRAGMA application_id').get()?.application_id;
  if(version===0&&app===0&&db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n===0)fail('STORE_INCOMPLETE');
  if(version!==1||app!==1280791363)fail('FORMAT_UNSUPPORTED');
}
export function assertOwnerIdentity(data:Data,guard:Authority):void {
  if(guard.storeId!==data.identity.storeId||guard.runId!==data.identity.lock.spec.runId||!equal(guard.lockHash,data.identity.lock.spec.lockHash)||guard.generation!==data.owner.generation||guard.ownerId!==data.owner.ownerId||guard.nonce!==data.owner.nonce)fail('STALE_OWNER');
}
/** One qualified local connection. No provider work or user callbacks occur in production transactions. */
export class Connection {
  private readonly statements=new Map<string,StatementSync>();
  private prepare(sql:string):StatementSync {let statement=this.statements.get(sql);if(!statement){statement=this.db.prepare(sql);this.statements.set(sql,statement);}return statement;}
  private closed=false;
  private clockBlocked=false;
  private readonly clock:ClockSource;
  constructor(private readonly db:Database,readonly expected:LocalRunIdentity,private readonly dependencies:Dependencies={}) {this.clock=dependencies.clock??systemClock;}
  private ensureOpen():void {if(this.closed)fail('STORE_CLOSED');if(!engineMatches())fail('RUNTIME_UNSUPPORTED');}
  assertOpen():void {this.ensureOpen();}
  private load():Data {
    try{
      requireHeader(this.db);
      if(schemaIdentity(this.db)!==expectedSchema())fail('STORE_CORRUPT');
      const meta=this.prepare('SELECT * FROM store_meta').all();const runs=this.prepare('SELECT * FROM run').all();
      if(meta.length!==1||runs.length!==1)fail('STORE_CORRUPT');const m=meta[0]!,r=runs[0]!;
      if(m.format_version!==1)fail('FORMAT_UNSUPPORTED');
      if(m.schema_digest!==expectedSchema()||m.engine_identity!==canonical(currentEngine())||m.profile_json!==canonical(PROFILE))fail('STORE_CORRUPT');
      const copy={...r};delete copy.record_digest;if(r.record_digest!==stateHash(copy as WriteRow))fail('STORE_CORRUPT');
      const body=record(parse(r.identity_json,1114112),['storeId','lock','policy','binding']);
      const saved=identity({directory:this.expected.directory,...body});const savedBody=identityBody(saved);
      if(m.store_id!==saved.storeId||r.run_id!==saved.lock.spec.runId||r.identity_digest!==hash('identity',savedBody).hex)fail('STORE_CORRUPT');
      if(!equal(saved.binding,this.expected.binding))fail('BINDING_MISMATCH');
      if(!equal(savedBody,identityBody(this.expected)))fail('IDENTITY_CONFLICT');
      const basis=clockBasis(parse(r.clock_basis_json,2048));
      const lastRecord=record(parse(r.clock_json,1024),['wallMs','monotonicMs','status']);if(lastRecord.status!=='trusted')fail('STORE_CORRUPT');
      const last=clockSample({wallMs:lastRecord.wallMs,monotonicMs:lastRecord.monotonicMs});
      if(basis.clockEpoch!==saved.binding.clockEpoch||basis.taskDeadlineMonotonicMs!==addMono(basis.created.monotonicMs,saved.lock.spec.contract.spec.budgets.wallTimeMs)||!clockValid(basis,basis.created,last))fail('STORE_CORRUPT');
      const owner={generation:numberColumn(r,'generation'),ownerId:r.owner_id===null?null:id(r.owner_id),nonce:r.owner_nonce===null?null:text(r.owner_nonce),mode:r.owner_mode===null?null:enumeration(r.owner_mode,['active','recovery']),leaseUntilMs:r.lease_until_ms===null?null:integer(r.lease_until_ms),leaseGrantedMonotonicMs:r.lease_granted_monotonic_ms===null?null:mono(r.lease_granted_monotonic_ms),leaseUntilMonotonicMs:r.lease_until_monotonic_ms===null?null:mono(r.lease_until_monotonic_ms)};
      if(owner.ownerId===null){if([owner.nonce,owner.mode,owner.leaseUntilMs,owner.leaseGrantedMonotonicMs,owner.leaseUntilMonotonicMs].some(v=>v!==null))fail('STORE_CORRUPT');}
      else if(owner.nonce===null||!/^[0-9a-f]{64}$/.test(owner.nonce)||owner.mode===null||owner.leaseUntilMs===null||owner.leaseGrantedMonotonicMs===null||owner.leaseUntilMonotonicMs===null||addMono(owner.leaseGrantedMonotonicMs,saved.policy.leaseMs)!==owner.leaseUntilMonotonicMs||project(basis,owner.leaseUntilMonotonicMs)!==owner.leaseUntilMs||BigInt(owner.leaseGrantedMonotonicMs)<BigInt(basis.created.monotonicMs)||BigInt(owner.leaseGrantedMonotonicMs)>BigInt(last.monotonicMs))fail('STORE_CORRUPT');
      const requests=this.prepare('SELECT * FROM requests ORDER BY sequence LIMIT 1025').all().map(row=>{
        const state=record(parse(row.state_json,16384),['state','dispatch','holdsSlot','chargedTokens','initialObservation','resolution','unresolvedReason','violations']);
        const request=storedRequest({sequence:row.sequence,admission:parse(row.admission_json,16384),admissionDigest:{algorithm:'sha256',hex:row.admission_digest},admissionGeneration:row.admission_generation,...state});
        if(request.admission.requestId!==row.request_id||request.admission.operationId!==row.operation_id)fail('STORE_CORRUPT');return request;
      });
      const operations=this.prepare('SELECT * FROM operations ORDER BY sequence LIMIT 2049').all().map(row=>{
        const state=record(parse(row.state_json,16384),['state','dispatch','initialReceipt','reconciliation','unresolvedReason']);
        const operation=storedOperation({sequence:row.sequence,intent:parse(row.intent_json,16384),intentDigest:{algorithm:'sha256',hex:row.intent_digest},intentGeneration:row.intent_generation,linkedRequestId:row.linked_request_id,...state});
        if(operation.intent.operationId!==row.operation_id)fail('STORE_CORRUPT');return operation;
      });
      const checkpointRows=this.prepare('SELECT * FROM checkpoints ORDER BY sequence LIMIT 65').all();
      const data:Data={identity:savedBody,identityDigest:hash('identity',savedBody),startedAtMs:numberColumn(r,'started_at_ms'),deadlineMs:numberColumn(r,'deadline_ms'),revision:numberColumn(r,'revision'),owner,basis,last,requests:requests as Data['requests'],operations:operations as Data['operations'],checkpoints:[],ledger:parse(r.ledger_json,16384) as Data['ledger'],counts:parse(r.record_counts_json,1024) as Data['counts'],ledgerRoot:{algorithm:'sha256',hex:text(r.ledger_root,'',64)}};
      if(data.startedAtMs!==basis.created.wallMs||data.deadlineMs!==checkedAdd(data.startedAtMs,saved.lock.spec.contract.spec.budgets.wallTimeMs))fail('STORE_CORRUPT');
      data.checkpoints=checkpointRows.map(row=>{const input=parse(row.input_json,65536),content=parse(row.checkpoint_json,65536);const result=storedCheckpoint(input,content,data);if(result.record.checkpointId!==row.checkpoint_id||result.record.sequence!==row.sequence||result.record.inputDigest.hex!==row.input_digest||hash('checkpoint-record',result.record).hex!==row.checkpoint_digest)fail('STORE_CORRUPT');return result;});
      if(data.checkpoints.some((c,i)=>c.record.sequence!==i+1))fail('STORE_CORRUPT');
      validateLinks(data);
      const expected=summaries(data);if([expected.ledger.chargedTokens,expected.ledger.reportedTokens,expected.ledger.estimatedTokens,expected.ledger.reportedCostMicrousd,expected.ledger.estimatedCostMicrousd].some(q=>q.safeValue===null)&&!expected.ledger.violations.includes('usage_overflow'))fail('STORE_CORRUPT');if(!equal(data.ledger,expected.ledger)||!equal(data.counts,expected.counts)||!equal(data.ledgerRoot,expected.ledgerRoot))fail('STORE_CORRUPT');
      return data;
    }catch(error){if(error!==null&&typeof error==='object'&&'errcode'in error)throw nativeFailure(error);if(error instanceof StateFailure&&['FORMAT_UNSUPPORTED','STORE_INCOMPLETE','BINDING_MISMATCH','IDENTITY_CONFLICT','STORE_BUSY','STORE_UNAVAILABLE'].includes(error.code))throw error;throw new StateFailure('STORE_CORRUPT');}
  }
  private now(data:Data):ClockSample {
    const now=clockSample(this.clock());if(!clockValid(data.basis,data.last,now))this.clockBlocked=true;return now;
  }
  isClockBlocked():boolean{return this.clockBlocked;}
  read<T>(operation:(data:Data,now:ClockSample)=>T):T {
    this.ensureOpen();let begun=false;
    try{this.db.exec('BEGIN');begun=true;const data=this.load(),now=this.now(data);const result=operation(data,now);this.db.exec('COMMIT');begun=false;return freeze(result);}
    catch(error){if(begun){try{if(this.db.isTransaction)this.db.exec('ROLLBACK');}catch{this.poison();fail('COMMIT_UNKNOWN');}}throw nativeFailure(error);}
  }
  mutate<T>(action:string,guard:Authority|ClaimGuard,operation:(data:Data,now:ClockSample)=>{changed:boolean;finish:()=>T}):T {
    this.ensureOpen();let begun=false,committing=false;
    try{
      this.db.exec('BEGIN IMMEDIATE');begun=true;const data=this.load();
      if('expectedGeneration'in guard){if(guard.expectedGeneration!==data.owner.generation||guard.expectedRevision!==data.revision)fail('REVISION_CONFLICT');}
      else assertOwnerIdentity(data,guard);
      const now=this.now(data);if(this.clockBlocked)fail('CLOCK_UNTRUSTED');
      if(!('expectedGeneration'in guard)&&data.owner.leaseUntilMonotonicMs!==null&&BigInt(now.monotonicMs)>=BigInt(data.owner.leaseUntilMonotonicMs))fail('OWNER_EXPIRED');
      const mutation=operation(data,now);
      if(mutation.changed){const oldRevision=data.revision;data.revision=checkedAdd(data.revision,1);data.last=now;Object.assign(data,summaries(data));this.persist(data,oldRevision);this.boundary(`${action}:before_commit`,data);}
      committing=true;this.db.exec('COMMIT');begun=false;
      if(mutation.changed)this.boundary(`${action}:after_commit`,data);
      return freeze(mutation.finish());
    }catch(error){
      if(committing){this.poison();fail('COMMIT_UNKNOWN');}
      if(begun){try{if(this.db.isTransaction)this.db.exec('ROLLBACK');}catch{this.poison();fail('COMMIT_UNKNOWN');}}
      throw nativeFailure(error);
    }
  }
  private boundary(phase:string,data:Data):void {this.dependencies.onBoundary?.({phase,storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,generation:data.owner.generation,revision:data.revision});}
  private persist(data:Data,oldRevision:number):void {
    for(const request of data.requests){
      const {sequence,admission,admissionDigest,admissionGeneration,...state}=request;
      this.upsert('requests','request_id',{request_id:admission.requestId,sequence,admission_json:this.encoded(admission,16384),admission_digest:admissionDigest.hex,admission_generation:admissionGeneration,operation_id:admission.operationId,state_json:this.encoded(state,16384)});
    }
    for(const operation of data.operations){
      const {sequence,intent,intentDigest,intentGeneration,linkedRequestId,...state}=operation;
      this.upsert('operations','operation_id',{operation_id:intent.operationId,sequence,intent_json:this.encoded(intent,16384),intent_digest:intentDigest.hex,intent_generation:intentGeneration,linked_request_id:linkedRequestId,state_json:this.encoded(state,16384)});
    }
    for(const checkpoint of data.checkpoints)this.upsert('checkpoints','checkpoint_id',{checkpoint_id:checkpoint.record.checkpointId,sequence:checkpoint.record.sequence,input_json:this.encoded(checkpoint.input,65536),input_digest:checkpoint.record.inputDigest.hex,checkpoint_json:this.encoded(checkpoint.record,65536),checkpoint_digest:hash('checkpoint-record',checkpoint.record).hex});
    const row=runRow(data);const columns=Object.keys(row).filter(key=>key!=='singleton');
    const result=this.prepare(`UPDATE run SET ${columns.map(c=>`${c}=?`).join(',')} WHERE singleton=1 AND revision=?`).run(...columns.map(c=>row[c]!),oldRevision);
    if(Number(result.changes)!==1)fail('REVISION_CONFLICT');
  }
  private encoded(value:unknown,max:number):string {const result=canonical(value);if(Buffer.byteLength(result)>max)fail('LIMIT_EXCEEDED');return result;}
  private upsert(table:'requests'|'operations'|'checkpoints',key:string,row:WriteRow):void {
    const keys=Object.keys(row),updates=keys.filter(c=>c!==key);
    this.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')}) ON CONFLICT(${key}) DO UPDATE SET ${updates.map(c=>`${c}=excluded.${c}`).join(',')} WHERE ${updates.map(c=>`${c} IS NOT excluded.${c}`).join(' OR ')}`).run(...Object.values(row));
  }
  private poison():void {this.closed=true;try{this.db.close();}catch{/* The handle remains unusable even if close fails. */}}
  close(){return attempt(()=>{if(!this.closed){this.db.close();this.closed=true;}return Object.freeze({closed:true as const});});}
}
export function configure(db:Database,fresh:boolean):void {
  if(fresh)db.exec('PRAGMA page_size=4096; PRAGMA journal_mode=DELETE');
  else if(db.prepare('PRAGMA journal_mode').get()?.journal_mode!=='delete'||db.prepare('PRAGMA page_size').get()?.page_size!==4096)fail('STORE_CORRUPT');
  db.exec('PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA locking_mode=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA max_page_count=65536');
  db.limits.length=2097152;db.limits.sqlLength=65536;db.limits.attach=0;
  const {length,sqlLength,attach}=db.limits;
  if(length!==2097152||sqlLength!==65536||attach!==0)fail('STORE_CORRUPT');
  for(const [name,value] of Object.entries(PROFILE)){const observed=db.prepare(`PRAGMA ${name}`).get();if(!observed||Object.values(observed)[0]!==value)fail('STORE_CORRUPT');}
}
export function openInternal(input:unknown,mode:'create'|'reopen',dependencies:Dependencies={}):Connection {
  if(!engineMatches())fail('RUNTIME_UNSUPPORTED');
  let expected:LocalRunIdentity;
  try{expected=identity(input);}catch(error){if(error instanceof StateFailure)throw error;fail('INVALID_INPUT');}
  freeze(expected);
  const path=join(expected.directory,'state.sqlite');let fresh=false,initialCommitAttempted=false;let db:Database|undefined;
  try{
    if(mode==='create'){
      try{mkdirSync(expected.directory,{mode:0o700});fresh=true;}catch(error){if(!(error!==null&&typeof error==='object'&&'code'in error&&error.code==='EEXIST'))throw error;}
    }
    if(!existsSync(expected.directory))fail('STORE_MISSING');if(!lstatSync(expected.directory).isDirectory()||lstatSync(expected.directory).isSymbolicLink())fail('STORE_CORRUPT');
    if(fresh){const fd=openSync(path,'wx',0o600);closeSync(fd);}else if(!existsSync(path))fail(mode==='create'?'STORE_INCOMPLETE':'STORE_MISSING');
    if(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())fail('STORE_CORRUPT');
    db=new Database(path,{timeout:250,allowExtension:false,defensive:true,enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
    configure(db,fresh);
    if(fresh){
      db.exec('BEGIN IMMEDIATE');
      try{
        db.exec(DDL);db.exec('PRAGMA application_id=1280791363; PRAGMA user_version=1');
        const now=clockSample((dependencies.clock??systemClock)());const basis=makeBasis(expected.binding.clockEpoch,now,expected.lock.spec.contract.spec.budgets.wallTimeMs);
        const body=identityBody(expected);const base={identity:body,requests:[],operations:[],checkpoints:[]};
        const data:Data={...base,identityDigest:hash('identity',body),startedAtMs:now.wallMs,deadlineMs:checkedAdd(now.wallMs,expected.lock.spec.contract.spec.budgets.wallTimeMs),revision:0,owner:{generation:0,ownerId:null,nonce:null,mode:null,leaseUntilMs:null,leaseGrantedMonotonicMs:null,leaseUntilMonotonicMs:null},basis,last:now,...summaries(base)};
        insert(db,'store_meta',{singleton:1,format_version:1,store_id:expected.storeId,engine_identity:canonical(currentEngine()),profile_json:canonical(PROFILE),schema_digest:expectedSchema()});insert(db,'run',runRow(data));initialCommitAttempted=true;db.exec('COMMIT');
      }catch(error){if(initialCommitAttempted)fail('COMMIT_UNKNOWN');try{if(db.isTransaction)db.exec('ROLLBACK');}catch{fail('COMMIT_UNKNOWN');}throw error;}
    }
    requireHeader(db);const integrity=db.prepare('PRAGMA quick_check(1)').all();if(integrity.length!==1||Object.values(integrity[0]!)[0]!=='ok')fail('STORE_CORRUPT');
    const connection=new Connection(db,expected,dependencies);connection.read(()=>null);return connection;
  }catch(error){try{db?.close();}catch{/* Preserve the original blocked result. */}if(initialCommitAttempted)fail('COMMIT_UNKNOWN');throw nativeFailure(error);}
}
export function runView(data:Data,now:ClockSample,blocked:boolean):RunView {
  const {nonce:_,...owner}=data.owner;void _;
  const elapsed=BigInt(now.monotonicMs)-BigInt(data.basis.created.monotonicMs);
  const remaining=BigInt(data.basis.taskDeadlineMonotonicMs)-BigInt(now.monotonicMs);
  return {storeId:data.identity.storeId,runId:data.identity.lock.spec.runId,lockHash:data.identity.lock.spec.lockHash,identityDigest:data.identityDigest,startedAtMs:data.startedAtMs,deadlineMs:data.deadlineMs,revision:data.revision,owner,policy:data.identity.policy,binding:data.identity.binding,
    clockStatus:blocked?'blocked':'trusted',clock:{basis:data.basis,lastCommittedSample:data.last,sampledNow:now,elapsedTaskMs:{decimal:String(elapsed),safeValue:elapsed>=-BigInt(Number.MAX_SAFE_INTEGER)&&elapsed<=BigInt(Number.MAX_SAFE_INTEGER)?Number(elapsed):null},remainingTaskMs:{decimal:String(remaining),safeValue:remaining>=-BigInt(Number.MAX_SAFE_INTEGER)&&remaining<=BigInt(Number.MAX_SAFE_INTEGER)?Number(remaining):null}},ledger:blocked?{...data.ledger,violations:[...data.ledger.violations,'clock_untrusted']}:data.ledger,counts:data.counts};
}
