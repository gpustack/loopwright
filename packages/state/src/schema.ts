import { DatabaseSync as Database } from 'node:sqlite';
import { canonical, hash } from './boundary.js';
const safe=(name:string)=>`${name} INTEGER NOT NULL CHECK(${name} BETWEEN 0 AND 9007199254740991)`;
const json=(name:string,max:number)=>`${name} TEXT NOT NULL CHECK(length(CAST(${name} AS BLOB))<=${max})`;
const digest=(name:string)=>`${name} TEXT NOT NULL CHECK(length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const key=(name:string)=>`${name} TEXT NOT NULL CHECK(length(${name}) BETWEEN 1 AND 64)`;
export const DDL=`
CREATE TABLE store_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format_version INTEGER NOT NULL CHECK(format_version=1),${key('store_id')} UNIQUE,${json('engine_identity',1024)},${json('profile_json',4096)},${digest('schema_digest')}) STRICT;
CREATE TABLE run(singleton INTEGER PRIMARY KEY CHECK(singleton=1),${key('run_id')} UNIQUE,${json('identity_json',1114112)},${digest('identity_digest')},${safe('started_at_ms')},${safe('deadline_ms')},${safe('revision')},${safe('generation')},owner_id TEXT NULL,owner_nonce TEXT NULL,owner_mode TEXT NULL,lease_until_ms INTEGER NULL,lease_granted_monotonic_ms TEXT NULL,lease_until_monotonic_ms TEXT NULL,${json('clock_basis_json',2048)},${json('clock_json',1024)},${json('ledger_json',16384)},${digest('ledger_root')},${json('record_counts_json',1024)},${digest('record_digest')},CHECK((owner_id IS NULL AND owner_nonce IS NULL AND owner_mode IS NULL AND lease_until_ms IS NULL AND lease_granted_monotonic_ms IS NULL AND lease_until_monotonic_ms IS NULL) OR (owner_id IS NOT NULL AND owner_nonce IS NOT NULL AND owner_mode IN ('active','recovery') AND lease_until_ms BETWEEN 0 AND 9007199254740991 AND lease_granted_monotonic_ms IS NOT NULL AND lease_until_monotonic_ms IS NOT NULL))) STRICT;
CREATE TABLE requests(${key('request_id')} PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 1024),${json('admission_json',16384)},${digest('admission_digest')},${safe('admission_generation')},${key('operation_id')} UNIQUE,${json('state_json',16384)},FOREIGN KEY(operation_id) REFERENCES operations(operation_id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE operations(${key('operation_id')} PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 2048),${json('intent_json',16384)},${digest('intent_digest')},${safe('intent_generation')},linked_request_id TEXT NULL UNIQUE,${json('state_json',16384)},FOREIGN KEY(linked_request_id) REFERENCES requests(request_id) DEFERRABLE INITIALLY DEFERRED) STRICT;
CREATE TABLE checkpoints(${key('checkpoint_id')} PRIMARY KEY,sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 64),${json('input_json',65536)},${digest('input_digest')},${json('checkpoint_json',65536)},${digest('checkpoint_digest')}) STRICT;
`;
export const PROFILE=Object.freeze({page_size:4096,journal_mode:'delete',synchronous:3,fullfsync:1,checkpoint_fullfsync:1,locking_mode:'normal',foreign_keys:1,busy_timeout:250,trusted_schema:0,cache_size:-2048,mmap_size:0,max_page_count:65536});
export const ENGINE=Object.freeze({platform:'darwin',architecture:'arm64',node:'v26.13.0',sqlite:'3.54.1'});
export function schemaIdentity(db:Database):string {
  return hash('identity',db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all().map(row=>({...row,sql:typeof row.sql==='string'?row.sql.replace(/\s+/g,' ').trim():row.sql}))).hex;
}
let expected:string|undefined;
export function expectedSchema():string {
  if(expected===undefined){const db=new Database(':memory:');try{db.exec(DDL);expected=schemaIdentity(db);}finally{db.close();}}return expected;
}
export function matchesEngine(profile:Readonly<Record<keyof typeof ENGINE,string|undefined>>):boolean {return canonical(ENGINE)===canonical(profile);}
export function engineMatches():boolean {return matchesEngine({platform:process.platform,architecture:process.arch,node:process.version,sqlite:process.versions.sqlite});}
