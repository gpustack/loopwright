/* global process, setTimeout, clearTimeout */
import { localOwner } from './native-context.mjs';
const nonce = process.argv[2]; if (!/^[a-f0-9]{32}$/.test(nonce ?? '')) process.exit(2);
process.stdout.write(JSON.stringify({ kind: 'hello', nonce, owner: localOwner() }) + '\n');
let input = '', started = false, work = Promise.resolve();
const timer = setTimeout(() => process.exit(73), 1500);
process.stdin.on('data', part => {
  input += part.toString(); if (input.length > 4096 || started) process.exit(74);
  if (input.endsWith('\n')) {
    const message = JSON.parse(input); if (message.kind !== 'ack' || message.nonce !== nonce) process.exit(75);
    started = true; clearTimeout(timer);
    work = (async () => {
      if (message.bindings) {
        const cp = await import('node:child_process'), defaults = cp.default, http = (await import('node:http')).default, https = (await import('node:https')).default;
        const { installOfflineBindings } = await import('./native-preload.mjs');
        const before = { spawn: cp.spawn, execFile: cp.execFile, fetch: globalThis.fetch, http: http.request, https: https.request };
        const restore = installOfflineBindings({ mode: 'offline' }, {}, () => {}, () => { throw new Error('unused fixture state'); });
        const changed = cp.spawn === defaults.spawn && cp.spawn !== before.spawn && cp.execFile === defaults.execFile && cp.execFile !== before.execFile;
        restore(); const restored = cp.spawn === before.spawn && cp.execFile === before.execFile && globalThis.fetch === before.fetch && http.request === before.http && https.request === before.https;
        process.stdout.write(JSON.stringify({ kind: 'bindings', nonce, changed, restored, underlyingCalls: 0 }) + '\n');
      }
      if (typeof message.refundPath === 'string') {
        const { NativeLedger } = await import('./native-ledger.mjs'); let code = null;
        try { new NativeLedger(message.refundPath).settle({ id: nonce }, {}); } catch (error) { code = error.message; }
        process.stdout.write(JSON.stringify({ kind: 'child-refund', nonce, code }) + '\n');
      }
      process.stdout.write(JSON.stringify({ kind: 'app-start', nonce }) + '\n');
      if (Number.isSafeInteger(message.holdMs) && message.holdMs > 0 && message.holdMs <= 3000) await new Promise(resolve => setTimeout(resolve, message.holdMs));
    })();
  }
});
process.stdin.on('end', () => { clearTimeout(timer); void work.then(() => process.exit(started ? 0 : 72), () => process.exit(76)); });
