import { reopenLocalRun, type LocalRunIdentity } from '@loopwright/state';
import type { Digest } from '@loopwright/core';
import { ControllerOwner, bootIdentity, processBirth } from '../../src/ownership.js';
import { ControllerFailure } from '../../src/errors.js';
import { hash } from '../../src/schema.js';
import { stateValue } from '../../src/storage.js';
// Deterministic local crash fixture, not an agent or alternate implementation.
process.once('message', (input: { nonce: string; directory: string; planDigest: Digest; identity: LocalRunIdentity; crashBoundary?: string }) => {
  void (async () => {
    if (input.crashBoundary === 'concurrent_resume_probe') {
      try {
        const owner = await ControllerOwner.acquire(input.directory, input.identity.lock.spec.runId, input.planDigest);
        await owner.release();
        process.send!({ type: 'refused', nonce: input.nonce, code: 'UNEXPECTED_ACQUIRE' });
      } catch (error) {
        process.send!({ type: 'refused', nonce: input.nonce, code: error instanceof ControllerFailure ? error.diagnostic.code : 'UNKNOWN' });
      }
      return;
    }
    if (input.crashBoundary === 'pre_intent') {
      const owner = await ControllerOwner.acquire(input.directory, input.identity.lock.spec.runId, input.planDigest);
      process.send!({ type: 'owned', nonce: input.nonce, pid: process.pid, birth: await processBirth(process.pid), boot: await bootIdentity(), ownerNonce: owner.nonce, view: null, authority: null });
      setInterval(() => {}, 1000); return;
    }
    const owner = await ControllerOwner.acquire(input.directory, input.identity.lock.spec.runId, input.planDigest), store = stateValue(reopenLocalRun(input.identity)), view = stateValue(store.inspect());
    const claim = stateValue(store.claim({ ownerId: 'fixture-child', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
    if (input.crashBoundary === 'post_dispatch_pre_receipt') {
      stateValue(store.putIntent(claim.authority, { operationId: 'child-uncertain-op', nodeId: 'build', attemptId: 'child-attempt', effect: 'read_only', requestDigest: hash('child crash window'), targetIdentity: 'fixture:child-crash' }));
      stateValue(store.authorizeOperationDispatch(claim.authority, 'child-uncertain-op'));
    }
    process.send!({ type: 'owned', nonce: input.nonce, pid: process.pid, birth: await processBirth(process.pid), boot: await bootIdentity(), ownerNonce: owner.nonce, view: stateValue(store.inspect()), authority: claim.authority });
    // Preserve both guards on abrupt death; the parent records and awaits this exact child.
    setInterval(() => {}, 1000);
  })().catch(error => { process.send!({ type: 'failed', code: error instanceof Error ? error.name : 'unknown' }); process.exitCode = 1; process.disconnect?.(); });
});
process.send!({ type: 'ready', pid: process.pid });
