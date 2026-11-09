/* global process */
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { reopenLocalRun } from '@loopwright/state';
import { providerShim, mcpShim, processShims } from './native-guards.mjs';
import { readPrivate, sha, same, fail } from './native-context.mjs';
import { requireNativeAppActivation } from './native-activation.mjs';

export function readPublicSnapshot(store) {
  const read = value => { if (!value.ok) fail('QUALIFICATION_STATE'); return value.value; }, view = read(store.inspect());
  const records = {};
  for (const [collection, maximum, method] of [['requests',1024,'listRequests'],['operations',2048,'listOperations'],['checkpoints',64,'listCheckpoints']]) {
    let cursor = null, last = 0; const items = [], expected = view.counts[collection];
    if (!Number.isSafeInteger(expected) || expected < 0 || expected > maximum) fail('QUALIFICATION_PAGE');
    do {
      const page = read(store[method]({ limit: 100, cursor })); if (page.revision !== view.revision || !Array.isArray(page.items) || page.items.length > 100) fail('QUALIFICATION_PAGE');
      if (!page.items.length && (expected !== 0 || items.length || cursor !== null || page.next !== null)) fail('QUALIFICATION_PAGE');
      for (const item of page.items) { if (!Number.isSafeInteger(item.sequence) || item.sequence <= last || item.sequence > maximum) fail('QUALIFICATION_PAGE'); last = item.sequence; items.push(item); if (items.length > expected) fail('QUALIFICATION_PAGE'); }
      if (page.next !== null && (!same(page.next, { storeId:view.storeId,runId:view.runId,collection,revision:view.revision,afterSequence:last }) || !page.items.length || last <= (cursor?.afterSequence ?? 0))) fail('QUALIFICATION_PAGE');
      cursor = page.next;
    } while (cursor !== null);
    if (items.length !== expected) fail('QUALIFICATION_PAGE'); records[collection] = items;
  }
  const final = read(store.inspect()); if (final.revision !== view.revision || !same(final.counts,view.counts) || !same(final.clock.basis,view.clock.basis) || final.storeId !== view.storeId || final.runId !== view.runId || !same(final.lockHash,view.lockHash)) fail('QUALIFICATION_STATE_CHANGED');
  return { view: final, records };
}
export function readOriginalState(path, expectedDigest, context) {
  const bytes = readPrivate(path); if (sha(bytes) !== expectedDigest) fail('QUALIFICATION_DESCRIPTOR_CHANGED');
  const descriptor = JSON.parse(bytes), identity = descriptor.identity;
  if (identity.storeId !== context.identity.storeId || identity.lock.spec.runId !== context.runId || !same(identity.lock.spec.lockHash, context.identity.lockHash)) fail('QUALIFICATION_DESCRIPTOR_CHANGED');
  const opened = reopenLocalRun(identity); if (!opened.ok) fail('QUALIFICATION_STATE'); const store = opened.value;
  try { return readPublicSnapshot(store).view; }
  finally { if (!store.close().ok) fail('QUALIFICATION_STATE_CLOSE'); }
}
/** Explicit OFFLINE-child factory. Import alone never patches worker, coordinator or container globals. */
export function installOfflineBindings(context, meter, observe, freshState, childObserved, targets = { globals: globalThis, childProcess, http, https }) {
  if (context.mode !== 'offline') fail('NATIVE_ACTIVATION_HELD');
  const originals = { fetch: targets.globals.fetch, execFile: targets.childProcess.execFile, spawn: targets.childProcess.spawn,
    execCustom: targets.childProcess.execFile[promisify.custom], http: targets.http.request, https: targets.https.request };
  if (typeof originals.execCustom !== 'function') fail('QUALIFICATION_PROMISIFY_UNAVAILABLE');
  const wrappers = processShims(context, meter, originals, observe, freshState, childObserved);
  targets.globals.fetch = providerShim(context, meter, originals.fetch); targets.http.request = mcpShim(context, meter, originals.http); targets.https.request = mcpShim(context, meter, originals.https);
  targets.childProcess.execFile = wrappers.execFile; targets.childProcess.spawn = wrappers.spawn;
  const actualBuiltins = targets.childProcess === childProcess && targets.http === http && targets.https === https && targets.globals === globalThis;
  if (actualBuiltins) syncBuiltinESMExports();
  let restored = false;
  return () => {
    if (restored) return; restored = true;
    targets.globals.fetch = originals.fetch; targets.http.request = originals.http; targets.https.request = originals.https;
    targets.childProcess.execFile = originals.execFile; targets.childProcess.spawn = originals.spawn;
    if (actualBuiltins) syncBuiltinESMExports();
  };
}
/** Prepared deferred registration: original public modules may load only after these bindings are installed. */
export function installPreparedBindings(declared,current,meter,observe,freshState,childObserved,resolveCommand,targets={globals:globalThis,childProcess,http,https},activation=null){
  if(declared.mode!=='offline'){requireNativeAppActivation(activation);if(declared.mode!=='native')fail('QUALIFICATION_CONTEXT');}
  const original={fetch:targets.globals.fetch,http:targets.http.request,https:targets.https.request,execFile:targets.childProcess.execFile,spawn:targets.childProcess.spawn,execCustom:targets.childProcess.execFile[promisify.custom]};
  if(typeof original.execCustom!=='function')fail('QUALIFICATION_PROMISIFY_UNAVAILABLE');
  const cache=new WeakMap();
  const active=()=>{const value=current();if(!value||value.context.mode!==declared.mode||value.context.executable!==declared.executable)fail('QUALIFICATION_ADMISSION_UNREGISTERED');return value;};
  const processes=()=>{const registration=active();if(!cache.has(registration))cache.set(registration,processShims(registration.context,meter,original,observe,()=>freshState(registration),childObserved,resolveCommand));return cache.get(registration);};
  targets.globals.fetch=(url,options)=>providerShim(active().context,meter,original.fetch)(url,options);
  targets.http.request=(options,callback)=>mcpShim(active().context,meter,original.http)(options,callback);
  targets.https.request=(options,callback)=>mcpShim(active().context,meter,original.https)(options,callback);
  const execFile=(file,args,options,callback)=>file!==declared.executable?original.execFile(file,args,options,...(callback===undefined?[]:[callback])):processes().execFile(file,args,options,callback);
  Object.defineProperty(execFile,promisify.custom,{value:(file,args,options)=>file!==declared.executable?original.execCustom(file,args,options):processes().execFile[promisify.custom](file,args,options)});
  targets.childProcess.execFile=execFile;targets.childProcess.spawn=(file,args,options)=>file!==declared.executable?original.spawn(file,args,options):processes().spawn(file,args,options);
  const actual=targets.globals===globalThis&&targets.childProcess===childProcess&&targets.http===http&&targets.https===https;if(actual)syncBuiltinESMExports();let restored=false;
  return()=>{if(restored)return;restored=true;targets.globals.fetch=original.fetch;targets.http.request=original.http;targets.https.request=original.https;targets.childProcess.execFile=original.execFile;targets.childProcess.spawn=original.spawn;if(actual)syncBuiltinESMExports();};
}
// A --import invocation is NOT an activation switch. Native installation needs another reviewed source revision.
if (process.execArgv.some((arg, index, args) => arg === '--import' && args[index + 1]?.includes('native-preload.mjs') || arg.startsWith('--import=') && arg.includes('native-preload.mjs'))) fail('NATIVE_ACTIVATION_HELD');
