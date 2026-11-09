import {mkdtempSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeLedger} from './native-ledger.mjs';
import {debitS03Reservation,parentTimeState} from './native-lock.mjs';
import {s03Caps,s03ActiveIdentity} from './s03-scope.mjs';
import {exclusive,canonical,sha,localOwner,monotonic} from './native-context.mjs';
const actual=resolve('.claude/s04-qualification/budget.json'),actualBefore=readFileSync(actual),entry=fileURLToPath(import.meta.url);
export function copiedS03Fixture(group='session',windowMs=100000,identity=s03ActiveIdentity){
  const directory=mkdtempSync(resolve('.claude/s04-development/s03-debit-')),path=join(directory,'budget.json'),original=JSON.parse(actualBefore);original.qualificationReservations.mode='offline';exclusive(path,original);const ledger=new NativeLedger(path),time=ledger.beginCopiedParentTime({directory,phase:'finalPi',leaf:'s03-'+group}),state=parentTimeState(time),before=exclusive(join(directory,'before.json'),readFileSync(path)),source=exclusive(join(directory,'selected-source.mjs'),'source bound; no execution');
  const plan={version:1,kind:'s03-quota-v1',group,project:resolve('.'),owner:localOwner(),identity,git:{head:'a'.repeat(40),tree:'b'.repeat(40)},phase:'finalPi',clock:{workCutoff:String(monotonic()+BigInt(windowMs)),hardCutoff:String(monotonic()+120000n)},caps:s03Caps(group),before,timeIntent:state.pending,image:'sha256:'+'a'.repeat(64),runtime:null,executable:'/usr/local/bin/docker',socket:'/Users/thxcode/.docker/run/docker.sock',client:join(directory,'docker-client'),directory,ownership:join(directory,'owned.json'),cpuLedger:join(directory,'cpu'),sources:[{path:source.path,byteLength:source.byteLength,sha256:source.sha256}],entries:[entry],argv:[entry],precharge:{provider:0,mcp:0}};
  plan.clock.hardCutoff=String(BigInt(plan.clock.workCutoff)+20000n);
  const ref=exclusive(join(directory,'plan.json'),plan),context={...identity,suite:'s03',sourceDigest:sha(canonical(plan.sources)),runtimeDigest:'b'.repeat(64),image:plan.image,leafCutoff:plan.clock.workCutoff,qualificationVersion:2,recipeDigest:sha(canonical(plan))},handle=ledger.reserve(context,plan.caps,ref);
  const base={reservationId:handle.id,plan:ref},input=(kind,key,identity={},units=1)=>({...base,kind,key,identity,units}),debit=i=>debitS03Reservation(path,i,{copied:true});return {directory,path,ledger,time,handle,ref,plan,base,input,debit,source};
}
