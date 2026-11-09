/* global process, Buffer, setTimeout, clearTimeout */
import { canonical, nonce, localOwner, checkedRef, exclusive } from './native-context.mjs';
import { receiveBootstrapTicket } from './native-ticket.mjs';
import { runApprovedNativeBootstrap } from './native-activation.mjs';
const ref={path:process.argv[2],sha256:process.argv[3],byteLength:Number(process.argv[4])},manifest=JSON.parse(checkedRef(ref)),challenge=nonce();
if(!['offline','native'].includes(manifest.mode))throw new Error('NATIVE_ACTIVATION_HELD');
process.stdout.write(canonical({kind:'bootstrap-hello',nonce:manifest.nonce,challenge,owner:localOwner()})+'\n');
let input='',started=false,work=Promise.resolve();
const timer=setTimeout(()=>process.exit(73),1500);
process.stdin.on('data',chunk=>{
  input+=chunk.toString();if(Buffer.byteLength(input)>16384||started)process.exit(74);
  if(!input.endsWith('\n'))return;
  started=true;clearTimeout(timer);
  work=(async()=>{
    try{
      const wire=JSON.parse(input);
      if(manifest.mode==='native'){
        const terminal=await runApprovedNativeBootstrap(ref,wire,challenge);
        process.stdout.write(canonical({kind:'bootstrap-native-terminal',ref:terminal.ref})+'\n');return;
      }
      const ticket=receiveBootstrapTicket(ref,wire,challenge);
      // App/guard imports occur only after authenticated original-parent ACK and synced registration.
      const {NativeMeter,meterSnapshot}=await import('./native-guards.mjs'),meter=new NativeMeter(ticket),probes=[];
      if(manifest.probe==='duplicate'){
        for(const action of [()=>receiveBootstrapTicket(ref,wire,challenge),()=>new NativeMeter(ticket),()=>new NativeMeter(JSON.parse('{}'))])try{action();probes.push({ok:true});}catch(error){probes.push({ok:false,code:error.message});}
      }
      if(manifest.probe==='refund'){
        const {NativeLedger}=await import('./native-ledger.mjs');try{new NativeLedger(manifest.ledger).settle({id:manifest.reservationId},{});probes.push({ok:true});}catch(error){probes.push({ok:false,code:error.message});}
      }
      const snapshot=meterSnapshot(meter.snapshot());
      const observation={kind:'bootstrap-observation',reservationId:manifest.reservationId,context:manifest.context,caps:manifest.caps,snapshot,probes,pending:0,containers:0,services:0};
      exclusive(ref.path+'.observation.json',observation);process.stdout.write(canonical(observation)+'\n');
    }catch(error){const result={kind:'bootstrap-refusal',code:error.message};exclusive(ref.path+'.refusal.json',result);process.stdout.write(canonical(result)+'\n');process.exitCode=76;}
  })();
});
process.stdin.on('end',()=>{clearTimeout(timer);void work.then(()=>process.exit(started?process.exitCode??0:72),()=>process.exit(76));});
