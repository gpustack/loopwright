/* global process, console */
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requestFixture, stateGood } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
const raw = resolve(process.argv[2] + '.evidence'); await mkdir(raw, { recursive: true });
const removedModules = [];
const original = await readFile('packages/agent-pi/dist/admission.js', 'utf8'), cases = [];
for (const mutation of ['baseline', 'current-owner', 'one-use']) {
 const content = mutation === 'current-owner' ? original.replace('this.#assertCurrent(value);', '') : mutation === 'one-use' ? original.replace(' || this.#used.has(ticket)', '') : original;
 if (mutation !== 'baseline') assert.notEqual(content, original);
 const modulePath = resolve('packages/agent-pi/dist/.admission-mutation-' + randomBytes(8).toString('hex') + '.js'); await writeFile(modulePath, content, { flag: 'wx' });
 try {
  const { Admission } = await import(pathToFileURL(modulePath).href);
  for (const behavior of ['owner-change', 'concurrent-duplicate']) {
   const f = await requestFixture();
   try {
    const admission = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch }), ticket = admission.issue(f.request, f.payload);
    let failures = 0;
    if (behavior === 'owner-change') {
     stateGood(f.host.store.release(f.host.authority)); const view = stateGood(f.host.store.inspect()); stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
     try { await admission.dispatch(ticket); } catch { failures++; }
    } else {
     const calls = await Promise.allSettled([admission.dispatch(ticket), admission.dispatch(ticket)]); failures = calls.filter(call => call.status === 'rejected').length;
    }
    const expected = behavior === 'owner-change' ? mutation === 'current-owner' ? 1 : 0 : mutation === 'one-use' ? 2 : 1;
    const entry = { mutation, behavior, physical: f.physical(), failures, expected, charge: stateGood(f.host.store.getRequest('request-1')).chargedTokens.decimal, sourceSha256: createHash('sha256').update(content).digest('hex') };
    cases.push(entry); await writeFile(join(raw, 'admission-mutations.json'), JSON.stringify(cases)); assert.equal(f.physical(), expected);
   } finally { await f.cleanup(); }
  }
 } finally { await unlink(modulePath); removedModules.push(modulePath); }
}
console.log(JSON.stringify({ passed: true, cases, evidence: raw, removedModules, originalUnchanged: original === await readFile('packages/agent-pi/dist/admission.js', 'utf8') }));
