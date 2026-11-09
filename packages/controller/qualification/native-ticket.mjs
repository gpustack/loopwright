/* global process, Buffer, URL */
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonical, same, sha, closed, bounded, checkedRef, localOwner, monotonic, fail } from './native-context.mjs';
import { requireNativeAppActivation } from './native-activation.mjs';
import { readBridgeLeaf, reservationContext } from './native-bridge.mjs';
const tickets = new WeakMap(), channels = new Set();
/** No record-to-meter factory: only this original-process, signed, registered bootstrap boundary brands tickets. */
export function receiveBootstrapTicket(manifestRef, wire, challenge, activation = null) {
  const key = canonical(manifestRef); if (channels.has(key)) fail('QUALIFICATION_TICKET_REPLAY'); channels.add(key);
  const manifest = JSON.parse(checkedRef(manifestRef));
  if(![1,2].includes(manifest.version)||!['offline','native'].includes(manifest.mode))fail('QUALIFICATION_TICKET_VERSION');
  if(manifest.version===1&&(manifest.mode!=='offline'||manifest.context.qualificationVersion!==undefined||manifest.recipe!==undefined))fail('QUALIFICATION_TICKET_VERSION');
  if(manifest.parent.pid!==process.ppid||!same(localOwner(process.ppid),manifest.parent))fail('QUALIFICATION_TICKET_PARENT');
  if(manifest.version===2){const recipe=readBridgeLeaf(manifest.recipe);if(recipe.mode!==manifest.mode||!same(reservationContext(recipe),manifest.context)||!same(recipe.caps,manifest.caps))fail('QUALIFICATION_TICKET_RECIPE');}
  const source=JSON.parse(checkedRef(manifest.source));
  if(!source.hashes||!Object.keys(source.hashes).length||Object.keys(source.hashes).length>128||sha(canonical(source.hashes))!==manifest.context.sourceDigest)fail('QUALIFICATION_TICKET_SOURCE');
  for(const [name,digest] of Object.entries(source.hashes))if(!/^[a-z0-9.-]+\.mjs$/.test(name)||sha(checkedRef(source.bodies[name]))!==digest||sha(readFileSync(new URL(name,import.meta.url)))!==digest)fail('QUALIFICATION_TICKET_SOURCE');
  if(manifest.context.runtimeDigest){if(!source.appBindings||Object.keys(source.appBindings).length>1024||sha(canonical(source.appBindings))!==manifest.context.runtimeDigest)fail('QUALIFICATION_TICKET_RUNTIME');for(const [path,digest] of Object.entries(source.appBindings))if(sha(checkedRef(source.appBodies[path]))!==digest||sha(readFileSync(path))!==digest)fail('QUALIFICATION_TICKET_RUNTIME');}
  closed(wire, ['body', 'signature', 'registration']);
  const body = closed(wire.body, ['version', 'nonce', 'challenge', 'reservationId', 'parent', 'child', 'caps', 'context',...(manifest.version===2?['recipeDigest']:[])]);
  if(body.version!==manifest.version||manifest.version===2&&body.recipeDigest!==manifest.context.recipeDigest)fail('QUALIFICATION_TICKET_RECIPE');
  if (body.nonce !== manifest.nonce || body.challenge !== challenge || body.reservationId !== manifest.reservationId) fail('QUALIFICATION_TICKET_BINDING');
  if (!same(body.parent, manifest.parent) || !same(body.child, localOwner())) fail('QUALIFICATION_TICKET_IDENTITY');
  closed(body.caps, ['provider', 'mcp', 'containers']);
  for (const [name, maximum] of [['provider',64],['mcp',128],['containers',64]]) bounded(body.caps[name], 0, maximum);
  if (!same(body.caps, manifest.caps)) fail('QUALIFICATION_TICKET_CAPS');
  if (!same(body.context, manifest.context)) fail('QUALIFICATION_TICKET_CONTEXT');
  if (monotonic() >= BigInt(body.context.leafCutoff)) fail('QUALIFICATION_TICKET_EXPIRED');
  if (typeof wire.signature !== 'string' || wire.signature.length > 256 || !verify(null, Buffer.from(canonical(body)), createPublicKey({ key:Buffer.from(manifest.publicKey, 'base64'), format:'der', type:'spki' }), Buffer.from(wire.signature, 'base64'))) fail('QUALIFICATION_TICKET_SIGNATURE');
  const registration = JSON.parse(checkedRef(wire.registration));
  if (!same(registration, {version:1,nonce:manifest.nonce,challenge,parent:body.parent,child:body.child,reservationId:body.reservationId,manifest:manifestRef})) fail('QUALIFICATION_TICKET_REGISTRATION');
  if(manifest.parent.pid!==process.ppid||!same(localOwner(process.ppid),manifest.parent))fail('QUALIFICATION_TICKET_PARENT');
  if(monotonic()>=BigInt(body.context.leafCutoff))fail('QUALIFICATION_TICKET_EXPIRED');
  if(manifest.mode==='native')requireNativeAppActivation(activation);
  const handle = Object.freeze({});
  tickets.set(handle, { used:false, reservation:{ ledger:null, ...(manifest.mode==='native'?{observationMode:'native'}:{}), entry:{ id:body.reservationId, owner:body.parent, caps:JSON.parse(canonical(body.caps)), context:JSON.parse(canonical(body.context)) } }, channelDigest:sha(canonical({manifestRef,wire})) });
  return handle;
}
export function claimObservationTicket(handle) {
  const value = tickets.get(handle); if (!value) return null;
  if (value.used) fail('QUALIFICATION_OBSERVATION_REPLAY'); value.used = true; return value.reservation;
}
