/* global process, Buffer */
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {closed,fail} from './native-context.mjs';
import {s03Budget,readS03Plan,s03DebitScope} from './s03-scope.mjs';
import {debitS03Reservation} from './native-lock.mjs';
import {installS03Io} from './s03-io.mjs';
// Environment data can only consume an EXISTING live original quota; it cannot create an activation/reservation.
const encoded=process.env.S04_S03_SCOPE;if(typeof encoded!=='string'||encoded.length>8192)fail('QUALIFICATION_S03_SCOPE');
const wire=JSON.parse(Buffer.from(encoded,'base64url'));closed(wire,['path','base','key']);closed(wire.base,['reservationId','plan']);
if(wire.path!==s03Budget||typeof wire.key!=='string')fail('QUALIFICATION_S03_SCOPE');
const plan=readS03Plan(wire.base.plan);s03DebitScope(wire.path,{...wire.base,kind:'claim',key:wire.key});
debitS03Reservation(wire.path,{...wire.base,kind:'claim',key:wire.key,units:0,identity:{}});
const io=installS03Io({path:wire.path,base:wire.base,plan});
export const stateObserver=io.stateObserver;
registerHooks({resolve(specifier,context,next){return specifier==='@loopwright/state'?{url:pathToFileURL(resolve(plan.project,'packages/controller/qualification/s03-state-facade.mjs')).href,shortCircuit:true}:next(specifier,context);}});
process.once('exit',()=>{try{io.flush();}catch(error){process.stderr.write('QUALIFICATION_S03_ACTOR_OBSERVATION:'+error.message+'\n');process.exitCode=1;}});
