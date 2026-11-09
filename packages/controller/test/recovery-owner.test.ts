import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { open, readFile, writeFile, lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { reopenLocalRun, type RunView } from '@loopwright/state';
import { retainedFixture } from './progress-fixtures.js';
import { ControllerOwner, processBirth, bootIdentity } from '../src/ownership.js';
import { ProgressStore } from '../src/progress.js';
import { stateValue } from '../src/storage.js';
import { GIT_ENVIRONMENT } from '../src/git-reader.js';
import { canonical, hash } from '../src/schema.js';
import { ControllerFailure } from '../src/errors.js';

function message(child: ChildProcess, expected: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('fixture timeout')); }, 5000);
    const received = (raw: Record<string, unknown>) => { if (raw.type === expected) { cleanup(); resolve(raw); } else { cleanup(); reject(new Error('unexpected fixture message')); } };
    const ended = () => { cleanup(); reject(new Error('fixture exited')); };
    function cleanup() { clearTimeout(timer); child.off('message', received); child.off('exit', ended); }
    child.once('message', received); child.once('exit', ended);
  });
}
test('a real live owner blocks past S02 lease expiry, then proven child death permits serialized same-boot recovery', async () => {
  const f = await retainedFixture(1, 3, 2, 1000), nonce = randomBytes(16).toString('hex'); let child: ChildProcess | null = null, recovered: ControllerOwner | null = null;
  try {
    const first = await f.progress.publish(f.draft, 'bootstrap'), original = stateValue(f.store.inspect());
    await writeFile(join(f.directory, 'setup-parent-owner.ndjson'), await readFile(f.owner.path), { mode: 0o600 });
    stateValue(f.store.release(f.authority)); stateValue(f.store.close()); await f.owner.release();
    const setup = join(f.directory, 'crash-fixture-intent.json'); await writeFile(setup, canonical({ version: 1, nonce, parentPid: process.pid, parentBirth: await processBirth(process.pid), boot: await bootIdentity(), module: 'fixtures/controller-process.js', directory: f.directory }), { mode: 0o600 });
    const setupFile = await open(setup, 'r'); try { await setupFile.sync(); } finally { await setupFile.close(); }
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/controller-process.js', import.meta.url))], { env: GIT_ENVIRONMENT, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child!.once('exit', (code, signal) => resolve({ code, signal })));
    const ready = await message(child, 'ready'); assert.equal(ready.pid, child.pid); const birth = await processBirth(child.pid!); assert.ok(birth);
    await writeFile(join(f.directory, 'crash-fixture-started.json'), canonical({ version: 1, nonce, pid: child.pid, birth, boot: await bootIdentity() }), { mode: 0o600 });
    const startedFile = await open(join(f.directory, 'crash-fixture-started.json'), 'r'); try { await startedFile.sync(); } finally { await startedFile.close(); }
    const owned = message(child, 'owned'); child.send({ nonce, directory: f.directory, planDigest: f.plan.planDigest, identity: f.identity });
    const live = await owned; assert.equal(live.nonce, nonce); assert.equal(live.pid, child.pid); assert.equal(live.birth, birth);
    await writeFile(join(f.directory, 'crash-fixture-owned.json'), canonical(live), { mode: 0o600 });
    await delay(1150);
    const observer = stateValue(reopenLocalRun(f.identity));
    try { const view = stateValue(observer.inspect()); assert.ok(BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.owner.leaseUntilMonotonicMs!)); assert.deepEqual(view.clock.basis, original.clock.basis); }
    finally { stateValue(observer.close()); }
    assert.equal(await processBirth(child.pid!), birth);
    await assert.rejects(ControllerOwner.acquire(f.directory, 'run-1', f.plan.planDigest), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'OWNER_BUSY');
    await writeFile(join(f.directory, 'dead-owner-prior.ndjson'), await readFile(join(f.directory, 'controller.owner.ndjson')), { mode: 0o600 });
    assert.equal(child.kill('SIGKILL'), true); const exit = await exited; assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
    assert.equal(await processBirth(child.pid!), null); assert.throws(() => process.kill(child!.pid!, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
    await writeFile(join(f.directory, 'crash-fixture-exit.json'), canonical({ version: 1, nonce, pid: child.pid, birth, ...exit, absenceConfirmed: true }), { mode: 0o600 });
    recovered = await ControllerOwner.acquire(f.directory, 'run-1', f.plan.planDigest);
    const store = stateValue(reopenLocalRun(f.identity));
    try {
      const view = stateValue(store.inspect()), claimed = stateValue(store.claim({ ownerId: 'recovery-parent', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'recovery' }));
      const retained = new ProgressStore(store, claimed.authority, f.artifacts, f.plan, f.lock, f.progress.planRef, f.progress.sourceRef), head = await retained.read();
      assert.ok(head); assert.equal(canonical(head), canonical(first)); assert.equal(retained.decision(head), 'safe');
      const after: RunView = stateValue(store.inspect()); assert.deepEqual(after.clock.basis, original.clock.basis); assert.equal(after.counts.checkpoints, 1); assert.deepEqual(after.ledger, original.ledger);
      await writeFile(join(f.directory, 'dead-owner-recovery-result.json'), canonical({ version: 1, status: 'passed', leaseExpiredWhileLive: true, liveGuardRefused: true, actualExit: exit, sameBootDeathConfirmed: true, originalClock: after.clock.basis, checkpoints: after.counts.checkpoints, recoveryAuthorityOnly: claimed.mode === 'recovery', auditPath: 'controller.recovered.' + live.ownerNonce + '.json', priorJournalDigest: hash(await readFile(join(f.directory, 'dead-owner-prior.ndjson'))) }), { mode: 0o600 });
    } finally { stateValue(store.close()); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill('SIGKILL'); await exit; }
    if (recovered) { await writeFile(join(f.directory, 'recovery-owner-closed.ndjson'), await readFile(recovered.path), { mode: 0o600 }); await recovered.release(); assert.equal(await lstat(recovered.path).then(() => true, error => error.code !== 'ENOENT'), false); }
    await f.close(false);
  }
});

test('crash fixture boundaries cover concurrent_resume_probe refusal, pre_intent safe recovery, and post_dispatch_pre_receipt reconciliation refusal', async () => {
  const script = fileURLToPath(new URL('./fixtures/controller-process.js', import.meta.url));
  for (const boundary of ['pre_intent', 'post_dispatch_pre_receipt'] as const) {
    const f = await retainedFixture(1, 3, 2, 1000), nonce = randomBytes(16).toString('hex');
    let child: ChildProcess | null = null, probe: ChildProcess | null = null;
    try {
      await f.progress.publish(f.draft, 'bootstrap'); stateValue(f.store.release(f.authority)); stateValue(f.store.close()); await f.owner.release();
      child = spawn(process.execPath, [script], { env: GIT_ENVIRONMENT, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child!.once('exit', (code, signal) => resolve({ code, signal })));
      await message(child, 'ready');
      const owned = message(child, 'owned'); child.send({ nonce, directory: f.directory, planDigest: f.plan.planDigest, identity: f.identity, crashBoundary: boundary });
      await owned;
      probe = spawn(process.execPath, [script], { env: GIT_ENVIRONMENT, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const probeExited = new Promise<void>(resolve => probe!.once('exit', () => resolve()));
      await message(probe, 'ready');
      const refused = message(probe, 'refused'); probe.send({ nonce: 'probe', directory: f.directory, planDigest: f.plan.planDigest, identity: f.identity, crashBoundary: 'concurrent_resume_probe' });
      assert.equal((await refused).code, 'OWNER_BUSY');
      probe.kill('SIGKILL'); await probeExited; probe = null;
      child.kill('SIGKILL'); await exited; child = null;
      if (boundary === 'post_dispatch_pre_receipt') await delay(1100);
      const store = stateValue(reopenLocalRun(f.identity));
      try {
        const view = stateValue(store.inspect()), claimed = stateValue(store.claim({ ownerId: 'recovery-parent', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'recovery' }));
        const retained = new ProgressStore(store, claimed.authority, f.artifacts, f.plan, f.lock, f.progress.planRef, f.progress.sourceRef), head = await retained.read();
        if (boundary === 'pre_intent') assert.equal(retained.decision(head), 'safe');
        else assert.throws(() => retained.decision(head), (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'RECOVERY_REQUIRED');
      } finally { stateValue(store.close()); }
    } finally {
      if (probe && probe.exitCode === null && probe.signalCode === null) probe.kill('SIGKILL');
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      try { await f.close(false); } catch { /* Fixture cleanup may fail after crash-recovery. */ }
    }
  }
});
