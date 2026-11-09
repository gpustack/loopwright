/* global Buffer, URL, AbortSignal, process */
import { promisify, types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { claimReservationObservation } from './native-ledger.mjs';
import { claimObservationTicket } from './native-ticket.mjs';
import { nativeRemoval } from './native-terminal.mjs';
import { canonical, sha, matchesExactAbsence, same, bounded, revoke, fail } from './native-context.mjs';
const meters = new WeakMap(), snapshots = new WeakMap(), opened = new WeakSet();
export class NativeMeter {
  constructor(handle) {
    if (opened.has(handle)) fail('QUALIFICATION_RESERVATION_REPLAY');
    const reservation = claimObservationTicket(handle) ?? claimReservationObservation(handle, 'parent'); opened.add(handle);
    meters.set(this, { reservation, counts: { provider: 0, mcp: 0, containers: 0 }, trace: [], active: new Map(), started: new Set(), unknown: false });
  }
  consume(kind, identity) {
    const data = meters.get(this); if (!data || data.unknown || data.trace.length >= 1024) fail('QUALIFICATION_TRACE_UNKNOWN');
    if (!Object.hasOwn(data.counts, kind) || data.counts[kind] >= data.reservation.entry.caps[kind]) fail('QUALIFICATION_LIMIT');
    if (kind === 'containers' && (!identity || !/^[a-f0-9]{32}$/.test(identity.nonce) || !/^lw-pi-(?:(?:tool|mcp)-)?[a-f0-9]{32}$/.test(identity.name) || identity.labels?.['org.loopwright.nonce'] !== identity.nonce || !/^sha256:[a-f0-9]{64}$/.test(identity.image))) fail('QUALIFICATION_CONTAINER_IDENTITY');
    if (kind === 'containers' && data.active.size >= 4) fail('QUALIFICATION_ACTIVE_LIMIT');
    const digest = sha(canonical(identity)); data.counts[kind]++; data.trace.push({ ordinal: data.trace.length + 1, kind, digest });
    if (kind === 'containers') { if (data.active.has(identity.nonce)) { data.unknown = true; fail('QUALIFICATION_CONTAINER_REPLAY'); } data.active.set(identity.nonce, identity); }
  }
  unknown() { meters.get(this).unknown = true; }
  start(identity) {
    const data = meters.get(this); if (data.unknown || !data.active.has(identity.nonce) || data.started.has(identity.nonce) || !same(data.active.get(identity.nonce), identity) || data.trace.length >= 1024) fail('QUALIFICATION_START_REPLAY');
    data.started.add(identity.nonce); data.trace.push({ ordinal: data.trace.length + 1, kind: 'container-start', digest: sha(canonical(identity)) });
  }
  removed(proof) {
    const data = meters.get(this);
    if(data.reservation.observationMode==='native'){
      proof=nativeRemoval(proof);
      if(proof.reservationId!==data.reservation.entry.id||proof.recipeDigest!==data.reservation.entry.context.recipeDigest)fail('QUALIFICATION_NATIVE_REMOVAL');
    }
    const original = data.active.get(proof.nonce);
    if (!original || !same(proof.identity, original) || !/^[a-f0-9]{64}$/.test(proof.id) || proof.running !== false || proof.removed !== true || proof.cli.code !== 0 || proof.cli.signal !== null
      || !matchesExactAbsence(proof.absence,proof.id)) fail('QUALIFICATION_CLEANUP_UNKNOWN');
    data.active.delete(proof.nonce);
  }
  snapshot() {
    const data = meters.get(this); if (!data || data.unknown || data.active.size) fail('QUALIFICATION_TRACE_UNKNOWN');
    const value = Object.freeze({}); snapshots.set(value, JSON.parse(canonical({ reservationId: data.reservation.entry.id, actual: data.counts, trace: data.trace }))); return value;
  }
}
export function meterSnapshot(handle) { const value = snapshots.get(handle); if (!value) fail('QUALIFICATION_COUNTER_PROOF'); return value; }
export const PROVIDER_URL = 'https://api.individual.githubcopilot.com/v1/messages?beta=true';
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
function dataOptions(value) {
  if (!value || types.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('QUALIFICATION_OPTIONS');
  const descriptors = Object.getOwnPropertyDescriptors(value); if (Object.values(descriptors).some(item => !('value' in item))) fail('QUALIFICATION_OPTIONS'); return value;
}
export function providerShim(context, meter, original) {
  return function fetch(url, options) {
    dataOptions(options);
    if (url !== PROVIDER_URL || !options || options.method !== 'POST' || options.redirect !== 'error' || !(options.body instanceof Uint8Array) || options.body.byteLength > 65536 || !(options.signal instanceof AbortSignal)) fail('QUALIFICATION_PROVIDER_ROUTE');
    for (const key of Object.keys(options)) if (!['method', 'headers', 'body', 'signal', 'redirect'].includes(key)) fail('QUALIFICATION_PROVIDER_ROUTE');
    if (types.isProxy(options.body) || types.isSharedArrayBuffer(options.body.buffer)) fail('QUALIFICATION_PROVIDER_ROUTE');
    revoke(context); if (aborted.call(options.signal)) fail('QUALIFICATION_REVOKED');
    meter.consume('provider', { route: PROVIDER_URL, body: sha(options.body), bytes: options.body.byteLength });
    revoke(context); if (aborted.call(options.signal)) fail('QUALIFICATION_REVOKED');
    return original(context.providerEndpoint, options);
  };
}
export function mcpShim(context, meter, original) {
  return function request(options, callback) {
    dataOptions(options);
    const endpoint = new URL(context.mcpEndpoint);
    if (!options || options.protocol !== endpoint.protocol || options.hostname !== endpoint.hostname || String(options.port) !== endpoint.port || options.path !== endpoint.pathname || options.method !== 'POST'
      || options.agent !== false || options.maxHeaderSize !== 8192 || typeof options.lookup !== 'function' || !(options.signal instanceof AbortSignal)) fail('QUALIFICATION_MCP_ROUTE');
    revoke(context); if (aborted.call(options.signal)) fail('QUALIFICATION_REVOKED'); meter.consume('mcp', { route: context.mcpEndpoint });
    revoke(context); if (aborted.call(options.signal)) fail('QUALIFICATION_REVOKED'); return original(options, callback);
  };
}
/** All optional preparation/public inspect/close I/O precedes revoke's actual same-epoch time sample. */
export function processShims(context, meter, originals, observe, freshState, childObserved = () => {}, resolveCommand = null) {
  let delegating = null;
  const check = (file, args, options) => {
    if (file !== context.executable) return null;
    if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 32768) || Buffer.byteLength(canonical(args)) > 65536 || !options || options.shell) fail('QUALIFICATION_DOCKER_ARGUMENTS');
    if (Object.keys(options).some(key => !['env', 'stdio', 'encoding', 'timeout', 'maxBuffer', 'shell'].includes(key))) fail('QUALIFICATION_DOCKER_ARGUMENTS');
    const entry = resolveCommand ? resolveCommand(args, options) : context.commands.find(command => same(command.argv, args)); if (!entry || !['read', 'preflight', 'create', 'start', 'cleanup', 'fixture'].includes(entry.kind)) fail('QUALIFICATION_DOCKER_ARGUMENTS');
    const fixture = entry.kind === 'fixture' && context.mode === 'offline' && file === process.execPath && args.length === 2 && args[0] === fileURLToPath(new URL('./native-handshake-fixture.mjs', import.meta.url)) && /^[a-f0-9]{32}$/.test(args[1]);
    if (!same(options.env, entry.environment) || (entry.kind === 'fixture' ? !fixture : args[0] !== '--config' || args[2] !== '--host' || args[3] !== 'unix://' + context.socket)) fail('QUALIFICATION_DOCKER_ARGUMENTS');
    const key = canonical({ file, args, kind: entry.kind });
    if (delegating !== null) { if (delegating !== key) fail('QUALIFICATION_REENTRANT'); return { entry, key, nested: true }; }
    observe(entry, args); // Durable observations/identity checks are BEFORE the final original public snapshot.
    const view = freshState(); // Includes original inspect AND close; must bind expected registration, never adopt current owner.
    if (entry.kind !== 'cleanup' && entry.kind !== 'read') revoke(context, view);
    else if (!same(view.identity, context.identity) && (view.storeId !== context.identity.storeId || !same(view.lockHash, context.identity.lockHash))) fail('QUALIFICATION_AUTHORITY');
    if (entry.kind === 'create') meter.consume('containers', entry.identity);
    if (entry.kind === 'start') meter.start(entry.identity);
    // Consumption is bounded memory only. Sample again immediately before delegating.
    if (entry.kind === 'create' || entry.kind === 'start' || entry.kind === 'fixture' || entry.kind === 'preflight') revoke(context, view);
    return { entry, key, nested: false };
  };
  const call = (original, file, args, options, rest) => {
    const checked = check(file, args, options); if (!checked || checked.nested) return original(file, args, options, ...rest);
    delegating = checked.key;
    let child;
    try { child = original(file, args, options, ...rest); }
    catch (error) { if (checked.entry.kind === 'create' || checked.entry.kind === 'start') meter.unknown(); throw error; }
    finally { delegating = null; }
    const actual = child?.child ?? child;
    if (!actual || !Number.isSafeInteger(actual.pid) || actual.pid < 1) meter.unknown();
    try { childObserved(actual, checked.entry); } catch { meter.unknown(); }
    return child;
  };
  const execFile = (file, args, options, callback) => call(originals.execFile, file, args, options, callback === undefined ? [] : [callback]);
  const spawn = (file, args, options) => call(originals.spawn, file, args, options, []);
  Object.defineProperty(execFile, promisify.custom, { value: (file, args, options) => call(originals.execCustom, file, args, options, []), configurable: false });
  return { execFile, spawn };
}
export function validateActual(value, caps) { for (const key of ['provider', 'mcp', 'containers']) bounded(value[key], 0, caps[key]); }
