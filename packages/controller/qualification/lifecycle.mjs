/* global process, Buffer, URL, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
import { readFileSync as readFileBytes } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reservationIdentity } from './native-ledger.mjs';
import { meterSnapshot } from './native-guards.mjs';
import { parentObservation } from './native-parent.mjs';
import { validateTerminalGraph } from './native-terminal.mjs';
import { canonical, sha, same, nonce, exclusive, checkedRef, readPrivate, localOwner, monotonic, privateDirectory, fail } from './native-context.mjs';
const proofs = new WeakMap();
export function terminalProof(handle) {
  const proof = proofs.get(handle); if (!proof) fail('QUALIFICATION_TERMINAL_PROOF');
  checkedRef(proof.sealRef); for (const ref of proof.refs) checkedRef(ref);if(proof.nativeGraph)validateTerminalGraph(proof.nativeGraph.ref,proof.nativeGraph.binding,proof.nativeGraph.roots);return proof;
}
/** Parent-owned no-app Node fixture only. Real native terminal certification remains activation-held. */
export class ParentLifecycle {
  constructor(reservation, directory) { privateDirectory(directory); this.reservation = reservationIdentity(reservation); this.directory = directory; this.children = []; this.failed = false; }
  async handshake({ acknowledge = true, cutoff = monotonic() + 5000n, token = nonce(), launch = spawn, bindings = false, holdMs = 0, refundPath = null } = {}) {
    if (!same(localOwner(), this.reservation.entry.owner)) fail('QUALIFICATION_PARENT_ONLY');
    if (this.children.length >= 64) fail('QUALIFICATION_CHILD_LIMIT');
    const intent = exclusive(join(this.directory, 'child-intent-' + token + '.json'), { version: 1, owner: this.reservation.entry.owner, nonce: token, fixture: 'no-app-before-ack' });
    const launched = launch(process.execPath, [fileURLToPath(new URL('./native-handshake-fixture.mjs', import.meta.url)), token], { env: { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = launched.child ?? launched;
    const record = { nonce: token, intent, actualPid: child.pid ?? null, hello: null, appStarted: false, exit: null, stdout: '', stderr: '', failure: null }; this.children.push(record);
    let timer;
    const closed = new Promise(resolve => { child.once('close', (code, signal) => { record.exit = { code, signal }; resolve(); }); child.once('error', error => { record.failure = error.code ?? 'SPAWN_FAILED'; }); });
    let rejectHello;
    const hello = new Promise((resolve, reject) => {
      rejectHello = reject;
      child.stdout.on('data', part => {
        record.stdout += part.toString();
        if (Buffer.byteLength(record.stdout) > 8192) { record.failure = 'OUTPUT_LIMIT'; reject(new Error(record.failure)); return; }
        const newline = record.stdout.lastIndexOf('\n'); if (newline < 0) return;
        const rows = record.stdout.slice(0, newline).split('\n');
        if (rows.length && rows[0]) {
          try {
            const value = JSON.parse(rows[0]); if (value.kind !== 'hello' || value.nonce !== token || value.owner.pid !== child.pid || !record.hello && !same(localOwner(child.pid), value.owner) || record.hello && !same(record.hello, value)) fail('QUALIFICATION_HANDSHAKE');
            if (!record.hello) { record.hello = value; resolve(value); }
            if (rows.length > 1) record.appStarted = rows.slice(1).some(line => JSON.parse(line).kind === 'app-start');
          } catch (error) { record.failure = error.message; reject(error); }
        }
      });
    });
    child.stderr.on('data', part => { record.stderr += part.toString(); if (Buffer.byteLength(record.stderr) > 8192) record.failure = 'OUTPUT_LIMIT'; });
    child.once('close', () => { if (!record.hello) rejectHello(new Error('QUALIFICATION_NO_HELLO')); });
    timer = setTimeout(() => { record.failure = 'HANDSHAKE_TIMEOUT'; rejectHello(new Error(record.failure)); child.kill('SIGKILL'); }, 5000);
    try {
      await hello;
      record.registered = exclusive(join(this.directory, 'child-started-' + token + '.json'), { version: 1, nonce: token, owner: record.hello.owner, parent: this.reservation.entry.owner });
      if (record.appStarted) fail('QUALIFICATION_PRE_ACK_APP');
      if (acknowledge && monotonic() < cutoff) child.stdin.end(canonical({ kind: 'ack', nonce: token, bindings, holdMs, refundPath }) + '\n'); else child.stdin.end();
      await closed;
      record.observed = exclusive(join(this.directory, 'child-exit-' + token + '.json'), record);
      if (record.failure || record.stderr) fail('QUALIFICATION_CHILD_UNKNOWN'); return record;
    } catch (error) { this.failed = true; record.failure ??= error.message; child.stdin.end(); await closed; throw error; }
    finally { clearTimeout(timer); if (!record.observed && record.exit) record.observed = exclusive(join(this.directory, 'child-exit-' + token + '.json'), record); }
  }
  seal(meter) {
    return this.#sealSnapshot(meterSnapshot(meter.snapshot()));
  }
  sealObserved(handle){
    const value=parentObservation(handle),record=value.record;
    if(!same(value.reservation,this.reservation)||this.children.length||record.exit?.code!==0||record.exit.signal!==null||record.error||record.stderr)fail('QUALIFICATION_PARENT_OBSERVATION');
    if(this.reservation.observationMode==='native'&&!value.nativeGraph)fail('QUALIFICATION_NATIVE_TERMINAL');
    this.nativeGraph=value.nativeGraph??null;this.additionalRefs=value.additionalRefs??[];
    if(this.nativeGraph)validateTerminalGraph(this.nativeGraph.ref,this.nativeGraph.binding,this.nativeGraph.roots);
    this.children.push({failure:null,exit:record.exit,actualPid:record.pid,appStarted:true,intent:record.intent,registered:record.registration,observed:record.observed});
    return this.#sealSnapshot(value.snapshot);
  }
  #sealSnapshot(snapshot){
    if (this.failed || !same(localOwner(), this.reservation.entry.owner) || !this.children.length || this.children.some(child => child.failure || child.exit?.code !== 0 || child.exit.signal !== null || !child.actualPid || !child.appStarted || !child.registered || !child.observed)) fail('QUALIFICATION_TERMINAL_EXIT');
    if (snapshot.reservationId !== this.reservation.entry.id) fail('QUALIFICATION_TERMINAL_IDENTITY');
    const sourcePath = join(this.directory, 'source-manifest.json'), sourceBytes = readPrivate(sourcePath), source = JSON.parse(sourceBytes);
    if (sha(canonical(source.hashes)) !== this.reservation.entry.context.sourceDigest) fail('QUALIFICATION_SOURCE_CHANGED');
    for (const [name, digest] of Object.entries(source.hashes)) {
      if (!/^[a-z0-9.-]+\.mjs$/.test(name) || sha(checkedRef(source.bodies[name])) !== digest || sha(readFileBytes(new URL(name, import.meta.url))) !== digest) fail('QUALIFICATION_SOURCE_CHANGED');
    }
    if(this.reservation.entry.context.runtimeDigest){if(sha(canonical(source.appBindings))!==this.reservation.entry.context.runtimeDigest)fail('QUALIFICATION_SOURCE_CHANGED');for(const [path,digest] of Object.entries(source.appBindings))if(sha(checkedRef(source.appBodies[path]))!==digest||sha(readFileBytes(path))!==digest)fail('QUALIFICATION_SOURCE_CHANGED');}
    const counters = exclusive(join(this.directory, 'terminal-counters-' + this.reservation.entry.id + '.json'), { version: 1, actual: snapshot.actual, reservationId: snapshot.reservationId });
    const trace = exclusive(join(this.directory, 'terminal-trace-' + this.reservation.entry.id + '.json'), { version: 1, trace: snapshot.trace, reservationId: snapshot.reservationId });
    const refs = [{ path: sourcePath, byteLength: sourceBytes.length, sha256: sha(sourceBytes) }, counters, trace, ...this.children.flatMap(child => [child.intent, child.registered, child.observed]),...(this.nativeGraph?[this.nativeGraph.ref,...this.additionalRefs]:[])]; if(refs.length>195)fail('QUALIFICATION_TERMINAL_LIMIT');for (const ref of refs) checkedRef(ref);
    const value = { reservationId: this.reservation.entry.id, owner: this.reservation.entry.owner, context: this.reservation.entry.context, actual: snapshot.actual, refs, ...(this.nativeGraph?{nativeGraph:this.nativeGraph}:{}),digest: sha(canonical({ refs, actual: snapshot.actual, reservationId: snapshot.reservationId })) };
    value.sealRef = exclusive(join(this.directory, 'terminal-seal-' + this.reservation.entry.id + '.json'), value);
    const handle = Object.freeze({}); proofs.set(handle, value); return handle;
  }
}
