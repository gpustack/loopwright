/* global process */
import { resolve } from 'node:path';
import { fail } from './native-context.mjs';
// Only the fixed approved source routes below issue membership; flags, environment, tickets and copies cannot.
const activations=new WeakSet();
export function requireNativeActivation(handle){if(!activations.has(handle))fail('NATIVE_ACTIVATION_HELD');}
const applications=new WeakSet();
// The fixed original bootstrap below owns this separate membership; an observation ticket is not activation.
export function requireNativeAppActivation(handle){if(!applications.has(handle))fail('NATIVE_ACTIVATION_HELD');}
// Fixed read-only preflight routes have separate membership from native application/parent holds.
const preflights=new WeakSet();
export function requireNativePreflightActivation(handle){if(!preflights.has(handle))fail('NATIVE_PREFLIGHT_ACTIVATION_HELD');}

// Historical fixed route still requires its original launcher context; current delivery uses the routes below.
export async function runApprovedImagePreflight(){
  const launcher=await import('./native-preflight-launcher.mjs');
  await launcher.requireFixedLauncherContext();
  const activation=Object.freeze({});preflights.add(activation);
  try{return await launcher.runFixedPreflight(activation);}finally{preflights.delete(activation);}
}

/** Fixed Node delivery route approved for this local program; no environment or decoded data issues membership. */
export async function runApprovedDeliveryBuild() {
  if (resolve('.') !== '/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller' || resolve(process.argv[1]??'') !== resolve('packages/controller/qualification/delivery-build.mjs')) fail('NATIVE_ACTIVATION_HELD');
  const activation=Object.freeze({});preflights.add(activation);
  try { const { buildCurrentImage }=await import('./delivery-build.mjs');return await buildCurrentImage(activation); } finally { preflights.delete(activation); }
}

export async function runApprovedDeliveryPreflight(bootstrap) {
  if (resolve('.') !== '/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller' || resolve(process.argv[1]??'') !== resolve('packages/controller/qualification/delivery-preflight.mjs') || process.argv.length !== 2) fail('NATIVE_PREFLIGHT_ACTIVATION_HELD');
  const activation=Object.freeze({});preflights.add(activation);
  try { const { executeCurrentPreflight }=await import('./delivery-preflight.mjs');return await executeCurrentPreflight(activation,bootstrap); } finally { preflights.delete(activation); }
}

export async function runApprovedDeliveryLeaf(leaf,phase){
  if(resolve('.')!=='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller'||resolve(process.argv[1]??'')!==resolve('packages/controller/qualification/delivery-native.mjs')||!['cycle','repair','assertion'].includes(leaf)||!['initial','finalController'].includes(phase))fail('NATIVE_ACTIVATION_HELD');
  const activation=Object.freeze({});activations.add(activation);
  try{const {executeNativeLeaf}=await import('./delivery-native.mjs');return await executeNativeLeaf(activation,leaf,phase);}finally{activations.delete(activation);}
}
/** A live held ledger owner plus the original signed one-use child channel are both required. */
export async function runApprovedNativeBootstrap(manifestRef,wire,challenge){
  if(resolve('.')!=='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller'||resolve(process.argv[1]??'')!==resolve('packages/controller/qualification/native-bootstrap.mjs'))fail('NATIVE_ACTIVATION_HELD');
  const {checkedRef,same,localOwner}=await import('./native-context.mjs'),{NativeLedger}=await import('./native-ledger.mjs');
  const manifest=JSON.parse(checkedRef(manifestRef)),path=resolve('.claude/s04-qualification/budget.json');
  if(manifest.mode!=='native'||manifest.ledger!==path||manifest.parent.pid!==process.ppid||!same(manifest.parent,localOwner(process.ppid)))fail('NATIVE_ACTIVATION_HELD');
  const book=new NativeLedger(path).read(),entry=book.qualificationReservations.entries.find(row=>row.id===manifest.reservationId);
  if(!entry||entry.state!=='held'||!same(entry.owner,manifest.parent)||!same(entry.context,manifest.context)||!same(entry.caps,manifest.caps)||entry.context.taskId!=='task_79ce55c2b3a8'||entry.context.dispatchId!=='ctx_242594ec6fb9'||entry.context.runId!=='run_316587aa2c7f'||entry.context.image!=='sha256:6c52d01f4514b2376422399be1b7909233373b0063d0d10920fbdc98343a7257')fail('NATIVE_ACTIVATION_HELD');
  const activation=Object.freeze({});applications.add(activation);
  try{const {receiveBootstrapTicket}=await import('./native-ticket.mjs'),ticket=receiveBootstrapTicket(manifestRef,wire,challenge,activation),{runHeldNativeApplication}=await import('./native-app.mjs');return await runHeldNativeApplication(activation,{ticket,manifest,recipe:manifest.recipe,directory:resolve(manifestRef.path,'..')});}finally{applications.delete(activation);}
}

/** Fixed R064/065/066 controller-owned S03 supervisor; scope records and env cannot issue membership. */
export async function runApprovedS03(bootstrap){
  if(resolve('.')!=='/Users/thxcode/orca/workspaces/loopwright/loopwright-s04-controller'||resolve(process.argv[1]??'')!==resolve('packages/controller/qualification/delivery-s03.mjs')||process.argv.length!==6||process.argv[2]!=='--case'||process.argv[4]!=='--owner'||process.argv[5]!=='controller')fail('NATIVE_ACTIVATION_HELD');
  const activation=Object.freeze({});activations.add(activation);
  try{const {executeS03Group}=await import('./delivery-s03.mjs');return await executeS03Group(activation,bootstrap,process.argv[3]);}finally{activations.delete(activation);}
}
