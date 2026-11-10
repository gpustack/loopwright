import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { appendFileSync, fsyncSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { admitTask, bindSubject, digestArtifact, type ArtifactManifest } from '@loopwright/core';
import { createLocalRun } from '@loopwright/state';
import { configurationFixture } from './config-fixtures.js';
import { compilePlan } from '../src/compile.js';
import { approvedState } from '../src/config.js';
import { ArtifactStore, privateDirectory, stateValue } from '../src/storage.js';
import { ControllerOwner, bootIdentity, processBirth } from '../src/ownership.js';
import { ProgressStore } from '../src/progress.js';
import { hash } from '../src/schema.js';
import type { ControllerProgress } from '../src/types.js';
export function setFixture(value: unknown, path: readonly (string | number)[], replacement: unknown): void {
  let object = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) object = object[key] as Record<string | number, unknown>;
  object[path.at(-1)!] = replacement;
}
export async function retainedFixture(checks = 1, A = 3, I = 2, leaseMs = 60000, modify?: (fixture: Awaited<ReturnType<typeof configurationFixture>>) => void) {
  const f = await configurationFixture();
  setFixture(f.config, ['spec', 'controls', 'maxAttempts'], A); setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], I);
  if (checks !== 1) {
    const prototype = f.registry.spec.handlers.find(item => item.implementation === 'json-artifact.v1')!;
    const ids = Array.from({ length: checks }, (_, index) => index ? 'tests-' + index : 'tests');
    setFixture(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers.filter(item => item !== prototype), ...ids.map(id => ({ ...prototype, id, parameters: { ...prototype.parameters, checkId: id } }))]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], { required: ids, checks: ids.map(id => ({ id, allowedEvidenceLevels: ['local_execution'] })) });
  }
  modify?.(f); await f.save();
  const loaded = await f.load(); assert.equal(loaded.ok, true); if (!loaded.ok) throw new Error('fixture');
  const compiled = await compilePlan(loaded.value); assert.equal(compiled.ok, true); if (!compiled.ok) throw new Error('fixture');
  const plan = compiled.value, directory = join(f.root, 'retained'); await privateDirectory(directory, [f.taskDirectory, process.cwd()]);
  const registryDirectory = resolve('.claude/s04-qualification'); mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });
  const registry = join(registryDirectory, 'progress-fixtures.ndjson');
  appendFileSync(registry, JSON.stringify({ version: 1, root: f.root, directory, pid: process.pid, birth: await processBirth(process.pid), boot: await bootIdentity(), kind: 's02-unit-fixture' }) + '\n', { mode: 0o600 });
  const registryFile = openSync(registry, 'r'); try { fsyncSync(registryFile); } finally { closeSync(registryFile); }
  const owner = await ControllerOwner.acquire(directory, 'run-1', plan.planDigest), artifactDirectory = join(directory, 'artifacts'); await privateDirectory(artifactDirectory);
  const artifacts = new ArtifactStore(artifactDirectory, owner, approvedState(loaded.value).vault);
  const admitted = admitTask(plan.task, { admissionId: 'admission-1', runId: 'run-1' }); assert.equal(admitted.ok, true); if (!admitted.ok) throw new Error('fixture'); const lock = admitted.value;
  const identity = { directory: join(directory, 'state'), storeId: 'store-1', lock, policy: { version: 1 as const, leaseMs, cost: 'observe_only' as const },
    binding: { coreApiVersion: 'loopwright.dev/v1alpha1' as const, hostVersion: 's04-controller-unit', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: plan.roles[0]!.policy.resourceVersion, clockEpoch: 'boot.' + hash(await bootIdentity()).hex.slice(0, 40) } };
  const store = stateValue(createLocalRun(identity)), initial = stateValue(store.inspect());
  const authority = stateValue(store.claim({ ownerId: 'controller-unit', expectedGeneration: initial.owner.generation, expectedRevision: initial.revision, mode: 'active' })).authority;
  const candidate = async (generation: number) => {
    const bytes = Buffer.from('export const value = ' + generation + ';\n'), ref = digestArtifact('packages/example.ts', bytes); assert.equal(ref.ok, true); if (!ref.ok) throw new Error('fixture');
    const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [ref.value] } };
    const subject = bindSubject(lock, manifest); assert.equal(subject.ok, true); if (!subject.ok) throw new Error('fixture');
    return { manifest: await artifacts.json('manifest', manifest, 32768), digest: subject.value.candidateDigest, generation, workspace: await artifacts.json('workspace', { version: 1, fixture: 'passive-candidate', generation }), privateSession: null };
  };
  const current = await candidate(0), planRef = await artifacts.json('plan', plan, 1048576), sourceRef = await artifacts.json('source', { version: 1, fixture: 'synthetic-source-inventory', manifest: current.manifest });
  const progress = new ProgressStore(store, authority, artifacts, plan, lock, planRef, sourceRef);
  const draft: Omit<ControllerProgress, 'sequence' | 'previous' | 'stage'> & { stage: Omit<ControllerProgress['stage'], 'consumed' | 'watermarks'> } = {
    version: 2, runId: lock.spec.runId, lockHash: lock.spec.lockHash, stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: plan.capacity },
    nodes: plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })), attempts: [], nativeCheckpoints: [], submission: null, publication: { status: 'idle', operationId: null, receipt: null }, candidate: current,
    failures: [], verifierReceipts: [], verifierRefusals: [], eventSequence: 0, terminalIntent: null,
  };
  return { ...f, loaded: loaded.value, plan, directory, owner, artifacts, store, authority, lock, identity, progress, draft, candidate,
    close: async (releaseOwner = true) => {
      stateValue(store.close());
      if (releaseOwner) { const journal = await readFile(owner.path); await writeFile(join(directory, 'closed-owner-journal.ndjson'), journal, { mode: 0o600 }); await owner.release(); }
      const absent = await lstat(owner.path).then(() => false, error => error.code === 'ENOENT'); assert.equal(absent, true);
      await writeFile(join(directory, 'fixture-closed.json'), JSON.stringify({ version: 1, storeClosed: true, ownerGuardAbsent: absent, retained: true }), { mode: 0o600 });
    } };
}
