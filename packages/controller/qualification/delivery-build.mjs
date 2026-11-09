/* global process */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeImage } from '../../agent-pi/qualification/runtime-image.mjs';
import { NativeLedger } from './native-ledger.mjs';
import { requireNativePreflightActivation, runApprovedDeliveryBuild } from './native-activation.mjs';
import { monotonic, canonical, exclusive, sha, localOwner, fail } from './native-context.mjs';
export async function buildCurrentImage(activation){
  requireNativePreflightActivation(activation);
  const directory=resolve('.claude/s04-qualification/delivery-build-003');mkdirSync(directory,{mode:0o700});
  const ledger=new NativeLedger(resolve('.claude/s04-qualification/budget.json')),started=monotonic(),time=ledger.beginHeldPreflightTime(activation,{phase:'initial',leaf:'derived-image-build',directory},started);
  const timing=ledger.preparePreflightTime(time);if(timing.availableSeconds<100)fail('QUALIFICATION_BUILD_ALLOWANCE');
  // The existing builder has the original count<=3, pinned base, pull=false/network=none and100s child deadline.
  // Fix PATH to the already-pinned Docker route before it imports/spawns any command; no ambient client configuration.
  const originalPath=process.env.PATH;process.env.PATH='/usr/local/bin:/usr/bin:/bin:/usr/sbin';
  let built=null,error=null;
  try{built=await runtimeImage({owner:'controller'});}catch(value){error=value.message;}
  finally{process.env.PATH=originalPath;}
  const output=exclusive(join(directory,'build-outcome.json'),{version:1,scope:'derived image build only; no SDK/controller acceptance',owner:localOwner(),built,error,startedMonotonicMs:String(started),endedMonotonicMs:String(monotonic()),builderSourceSha256:sha(readFileSync('packages/agent-pi/qualification/runtime-image.mjs'))});
  // A builder failure can hide a still-live builder process; retain its existing fence for explicit investigation.
  const timed=ledger.completeHeldPreflightTime(activation,time,{intent:null,output,error:error===null?null:{message:error},reads:[],endedMonotonicMs:String(monotonic())});
  if(error)fail('QUALIFICATION_BUILD_FAILED');return {output,image:built.image,...timed};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){runApprovedDeliveryBuild().then(value=>process.stdout.write(canonical(value)+'\n'),error=>{process.stderr.write(canonical({error:error.message})+'\n');process.exitCode=1;});}
