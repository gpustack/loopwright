import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Admission } from '../src/admission.js';
import { PiFailure } from '../src/errors.js';
import { requestFixture, stateGood } from './request-fixtures.js';
test('original live permit dispatches once even while its first HTTP response is pending', async () => {
  const f = await requestFixture();
  try {
    const admission = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch });
    const ticket = admission.issue(f.request, f.payload), first = admission.dispatch(ticket);
    await assert.rejects(admission.dispatch(ticket), error => error instanceof PiFailure && error.detail.code === 'REQUEST_REFUSED');
    assert.equal((await first).status, 200); assert.equal(f.physical(), 1);
    assert.ok(!JSON.stringify(stateGood(f.host.store.getRequest('request-1'))).includes('SYNTHETIC_HOST_SECRET'));
  } finally { await f.cleanup(); }
});
test('owner changed after authorization sends zero and retains the original reserved charge', async () => {
  const f = await requestFixture();
  try {
    const admission = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch }), ticket = admission.issue(f.request, f.payload);
    stateGood(f.host.store.release(f.host.authority)); const view = stateGood(f.host.store.inspect()); stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
    await assert.rejects(admission.dispatch(ticket), error => error instanceof PiFailure && error.detail.code === 'AUTHORITY_REFUSED');
    assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.getRequest('request-1')).chargedTokens.decimal, '120');
  } finally { await f.cleanup(); }
});
test('a saved dispatch marker never recreates its original live permit', async () => {
  const f = await requestFixture();
  try {
    const first = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch }); first.issue(f.request, f.payload);
    const reopenedController = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch });
    assert.throws(() => reopenedController.issue(f.request, f.payload), error => error instanceof PiFailure && error.detail.code === 'REQUEST_REFUSED'); assert.equal(f.physical(), 0);
  } finally { await f.cleanup(); }
});
test('original permit expiry never slides when the owner lease is renewed', async () => {
  const f = await requestFixture();
  try {
    const admission = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch }), ticket = admission.issue(f.request, f.payload);
    await new Promise(resolve => setTimeout(resolve, 600)); stateGood(f.host.store.renew(f.host.authority)); await new Promise(resolve => setTimeout(resolve, 600));
    await assert.rejects(admission.dispatch(ticket), error => error instanceof PiFailure && error.detail.code === 'AUTHORITY_REFUSED'); assert.equal(f.physical(), 0);
  } finally { await f.cleanup(); }
});
test('forged tickets and changed persistent payload identity never send', async () => {
  const f = await requestFixture();
  try {
    const admission = new Admission(f.host, { destination: f.destination, fetch: globalThis.fetch }); admission.issue(f.request, f.payload);
    await assert.rejects(admission.dispatch({ requestId: 'request-1' }), error => error instanceof PiFailure && error.detail.code === 'REQUEST_REFUSED');
    assert.throws(() => admission.issue({ ...f.request, targetIdentity: 'changed' }, f.payload), PiFailure); assert.equal(f.physical(), 0);
  } finally { await f.cleanup(); }
});
