/* global process */
import {readFileSync} from 'node:fs';
import * as original from '../../state/dist/index.js';
import {stateObserver} from './pi-count-preload.mjs';
import {keepReplacementAlive} from './pi-crash-lease.mjs';
export function createLocalRun(input){
  const opened=original.createLocalRun(input);
  if(opened.ok&&process.argv[1]?.endsWith('/recovery-crashes.mjs'))keepReplacementAlive(opened.value);
  return stateObserver.wrap(opened,input);
}
export function reopenLocalRun(input){
  const opened=original.reopenLocalRun(input);
  // REVIEW-072/073 guards: the recovery crash child inherits a 1000ms lease across fork + preload + reopen;
  // refresh the original authority from its recorded child input on reopen, and refresh owner-1 when the child
  // hits its stop(phase) boundary for every mode except before-checkpoint, whose 1100ms expiry is asserted.
  if(opened.ok&&process.argv[1]?.endsWith('/recovery-crash-child.mjs')&&process.argv[2]){
    try{const child=JSON.parse(readFileSync(process.argv[2],'utf8')),auth=child?.host?.authority;if(auth){opened.value.renew(auth);if(child?.mode&&child.mode!=='before-checkpoint'&&typeof process.send==='function'){const send=process.send.bind(process);process.send=(msg,...rest)=>{if(msg?.kind==='boundary')try{opened.value.renew(auth);}catch{/* Ignore post-close or stale renew. */}return send(msg,...rest);};}}}catch{/* Missing or foreign child input keeps the original lease behavior. */}
  }
  if(opened.ok&&process.argv[1]?.endsWith('/recovery-crashes.mjs'))keepReplacementAlive(opened.value);
  return stateObserver.wrap(opened,input);
}
