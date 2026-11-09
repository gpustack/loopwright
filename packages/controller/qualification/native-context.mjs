/* global process, Buffer, AbortSignal, URL */
import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, lstatSync, fstatSync, realpathSync } from 'node:fs';
import { types } from 'node:util';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { requireNativeAppActivation } from './native-activation.mjs';
const originalOwnerMetadata=execFileSync;
export const fail = code => { throw new Error(code); };
export const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const same = (a, b) => canonical(a) === canonical(b);
export const nonce = () => randomBytes(16).toString('hex');
export const monotonic = () => process.hrtime.bigint() / 1000000n;
export function closed(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('QUALIFICATION_SHAPE');
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).length !== keys.length || keys.some(key => !entries[key] || !('value' in entries[key]) || !entries[key].enumerable)) fail('QUALIFICATION_SHAPE');
  return value;
}
export function bounded(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('QUALIFICATION_LIMIT'); return value; }
export function privateDirectory(path) {
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077 || realpathSync(path) !== resolve(path)) fail('QUALIFICATION_DIRECTORY');
}
export function readPrivate(path, maximum = 1048576) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file), current = lstatSync(path); if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > maximum) fail('QUALIFICATION_FILE');
    const bytes = readFileSync(file); if (bytes.length !== stat.size || bytes.length > maximum) fail('QUALIFICATION_FILE'); return bytes;
  } finally { closeSync(file); }
}
export function matchesExactAbsence(observation,identity){
  if(!observation||observation.code!==1||observation.signal!==null||typeof observation.stdout!=='string'||!['','[]'].includes(observation.stdout.trim())||typeof observation.stderr!=='string')return false;
  const matched=/^error: no such (?:object|container): (.+)$/i.exec(observation.stderr.trim());return matched!==null&&matched[1]===identity;
}
export function syncParent(path) { const file = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(file); } finally { closeSync(file); } }
export function exclusive(path, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value) + '\n'); if (bytes.length > 1048576) fail('QUALIFICATION_BYTES');
  const file = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(file, bytes); fsyncSync(file); } finally { closeSync(file); } syncParent(path);
  return { path, byteLength: bytes.length, sha256: sha(bytes) };
}
export function checkedRef(ref) {
  closed(ref, ['path', 'byteLength', 'sha256']); const bytes = readPrivate(ref.path); if (bytes.length !== ref.byteLength || sha(bytes) !== ref.sha256) fail('QUALIFICATION_EVIDENCE'); return bytes;
}
const bootTimeCache = { value: null };
const selfOwnerCache = { value: null };
const liveOwnerCache = new Map();
export function localOwner(pid = process.pid) {
  bounded(pid, 1, Number.MAX_SAFE_INTEGER);
  // REVIEW-076/077: kern.boottime is invariant for the host's uptime and a running process's own birth identity
  // is fixed; caching them removes ~90k redundant ps/sysctl spawns from teardown-scale debit traffic. Non-self
  // pids cache after one verified read: a live POSIX process cannot mutate its lstart or kern.boottime without
  // exiting, so a signal-0 probe on a cache hit returns the cached identity (~0.001ms); on ESRCH the cached
  // entry is dropped and the live /bin/ps read runs so dead-PID callers observe the exact unchanged exit error.
  if (pid === process.pid && selfOwnerCache.value) return selfOwnerCache.value;
  if (pid !== process.pid && liveOwnerCache.has(pid)) {
    try { process.kill(pid, 0); return liveOwnerCache.get(pid); }
    catch (error) { if (error.code !== 'ESRCH') return liveOwnerCache.get(pid); liveOwnerCache.delete(pid); }
  }
  const options = { encoding: 'utf8', timeout: 2000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' } };
  const birth = originalOwnerMetadata('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options).trim();
  if (!bootTimeCache.value) bootTimeCache.value = originalOwnerMetadata('/usr/sbin/sysctl', ['-n', 'kern.boottime'], options).trim();
  const boot = bootTimeCache.value;
  if (!birth || !boot || birth.length > 128 || boot.length > 256) fail('QUALIFICATION_OWNER');
  const owner = { pid, birth, boot };
  if (pid === process.pid) selfOwnerCache.value = owner; else liveOwnerCache.set(pid, owner);
  return owner;
}
export function bindContext(input, activation = null) {
  closed(input, ['mode', 'runId', 'taskId', 'dispatchId', 'sourceDigest', 'image', 'identity', 'owner', 'basis', 'workCutoff', 'leafCutoff', 'signal', 'cancelled', 'providerEndpoint', 'mcpEndpoint', 'executable', 'socket', 'commands']);
  if (input.mode !== 'offline') { requireNativeAppActivation(activation); if(input.mode!=='native')fail('QUALIFICATION_CONTEXT'); }
  for (const key of ['runId', 'taskId', 'dispatchId']) if (typeof input[key] !== 'string' || !/^[a-z0-9._-]{1,128}$/i.test(input[key])) fail('QUALIFICATION_CONTEXT');
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest) || !/^sha256:[a-f0-9]{64}$/.test(input.image)) fail('QUALIFICATION_CONTEXT');
  closed(input.owner, ['id', 'generation']); bounded(input.owner.generation, 1, Number.MAX_SAFE_INTEGER);
  closed(input.identity, ['storeId', 'lockHash']);
  closed(input.basis, ['clockEpoch', 'created', 'taskDeadlineMonotonicMs']);
  for (const key of ['workCutoff', 'leafCutoff']) if (!/^[0-9]{1,32}$/.test(input[key])) fail('QUALIFICATION_CONTEXT');
  if (!(input.signal instanceof AbortSignal) || typeof input.cancelled !== 'function' || !Array.isArray(input.commands) || input.commands.length > 256) fail('QUALIFICATION_CONTEXT');
  for (const endpoint of [input.providerEndpoint, input.mcpEndpoint]) { const url = new URL(endpoint); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash || url.search) fail('QUALIFICATION_ENDPOINT'); }
  // This is a private offline factory, not an authoring/configuration input or a production activation path.
  if (BigInt(input.workCutoff) > BigInt(input.basis.taskDeadlineMonotonicMs)) fail('QUALIFICATION_CONTEXT');
  const basis = JSON.parse(canonical(input.basis)); Object.freeze(basis.created); Object.freeze(basis);
  return Object.freeze({ ...input, identity: Object.freeze(JSON.parse(canonical(input.identity))), owner: Object.freeze({ ...input.owner }), basis, commands: Object.freeze(input.commands.map(command => Object.freeze({ ...command, argv: Object.freeze([...command.argv]) }))) });
}
export function revoke(context, view = null) {
  const cancelled = context.cancelled(), aborted = context.signal.aborted;
  if (view && (view.clockStatus !== 'trusted' || view.storeId !== context.identity.storeId || !same(view.lockHash, context.identity.lockHash) || !same(view.clock.basis, context.basis) || view.runId !== context.runId || view.owner.ownerId !== context.owner.id || view.owner.generation !== context.owner.generation || view.owner.mode !== 'active'
    || view.owner.leaseUntilMonotonicMs === null)) fail('QUALIFICATION_AUTHORITY');
  const now = monotonic(); // AFTER every callback/read/close and expected-identity comparison.
  if (aborted || cancelled || now >= BigInt(context.workCutoff) || now >= BigInt(context.leafCutoff) || now >= BigInt(context.basis.taskDeadlineMonotonicMs)) fail('QUALIFICATION_REVOKED');
  if (view && now >= BigInt(view.owner.leaseUntilMonotonicMs)) fail('QUALIFICATION_AUTHORITY');
  return now;
}
