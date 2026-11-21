import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { admitTask, digestArtifact, type ResourceActivationRule, type TaskLock } from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import { constructAdapter, type FactoryPorts } from '../src/adapter.js';
import { canonical, digest } from '../src/boundary.js';
import { PiFailure } from '../src/errors.js';
import { MAX_LIMITS } from '../src/policy.js';
import { prepareInput } from '../src/preflight.js';
import { PROVIDER_DESTINATION } from '../src/provider.js';
import { recoverSnapshot } from '../src/recovery.js';
import { HOST_PREAMBLE, PREAMBLE_IDENTITY, systemPrompt } from '../src/resources.js';
import { Sender } from '../src/sender.js';
import { rowBytes } from '../src/snapshot.js';
import type { PiCapabilities, PiOpenInput, ResourceIdentity } from '../src/types.js';
import { requestFixture, stateGood } from './request-fixtures.js';
import { sessionInput } from './session-fixtures.js';

interface FixtureResource {
  readonly id: string;
  readonly kind: ResourceIdentity['kind'];
  readonly path: string;
  readonly bytes: Buffer;
  readonly ref: PiOpenInput['resources'][number]['ref'];
  readonly identity: ResourceIdentity;
  readonly when?: ResourceActivationRule;
}

function makeFixtureResource(
  id: string,
  kind: ResourceIdentity['kind'],
  path: string,
  text: string,
  when?: ResourceActivationRule,
): FixtureResource {
  const bytes = Buffer.from(text, 'utf8');
  const digested = digestArtifact(path, bytes);
  assert.equal(digested.ok, true);
  if (!digested.ok) throw new Error('digestArtifact failed');
  const identity: ResourceIdentity = {
    id,
    kind,
    path: digested.value.name,
    digest: digested.value.digest,
  };
  return {
    id,
    kind,
    path: digested.value.name,
    bytes,
    ref: digested.value,
    identity,
    ...(when !== undefined ? { when } : {}),
  };
}

function toMountedResource(resource: FixtureResource): PiOpenInput['resources'][number] {
  return {
    id: resource.id,
    kind: resource.kind,
    ref: structuredClone(resource.ref),
    bytes: Buffer.from(resource.bytes),
  };
}

function makeConditionalFixture(options?: {
  readonly roleResourceIds?: readonly string[];
  readonly mounted?: readonly FixtureResource[];
  readonly admissionId?: string;
  readonly runId?: string;
}): {
  readonly resBase: FixtureResource;
  readonly resTs: FixtureResource;
  readonly resRepair: FixtureResource;
  readonly lock: TaskLock;
  readonly input: PiOpenInput;
} {
  const resBase = makeFixtureResource(
    'res-base',
    'instruction',
    'docs/base-rule.md',
    'Always preserve deterministic repository invariants.\n',
  );
  const resTs = makeFixtureResource(
    'res-ts',
    'skill',
    'docs/ts-rule.md',
    'TypeScript files must use strict ESM NodeNext imports.\n',
    { extensions: ['.ts'], phases: ['author', 'repair'] },
  );
  const resRepair = makeFixtureResource(
    'res-repair',
    'document',
    'docs/repair-rule.md',
    'Inspect failing verify receipts before modifying code.\n',
    { phases: ['repair'], failedChecks: ['verify'] },
  );

  const allResources = [resBase, resTs, resRepair] as const;
  const contractResources = allResources.map(item => ({
    id: item.id,
    kind: item.kind,
    path: item.path,
    digest: item.identity.digest,
    ...(item.when !== undefined ? { when: item.when } : {}),
  }));

  const task = contract();
  task.spec.roles[0]!.model = 'claude-sonnet-5.5';
  task.spec.roles[0]!.thinking = 'xhigh';
  task.spec.roles[0]!.tools = ['read'];
  if (options?.roleResourceIds !== undefined) {
    (task.spec.roles[0] as unknown as { resourceIds?: readonly string[] }).resourceIds = [...options.roleResourceIds];
  }
  (task.spec.trustedContext as unknown as { resources: typeof contractResources }).resources = contractResources;
  task.spec.budgets.wallTimeMs = 60000;
  task.spec.budgets.totalTokens = 1000000;
  task.spec.budgets.perCallOutputTokens = 1024;

  const lockRes = admitTask(task, {
    admissionId: options?.admissionId ?? 'admission-subset-1',
    runId: options?.runId ?? 'run-subset-1',
  });
  assert.equal(lockRes.ok, true, JSON.stringify(lockRes));
  if (!lockRes.ok) throw new Error('admitTask failed');

  const roleResources = options?.roleResourceIds === undefined
    ? allResources
    : options.roleResourceIds.map(resourceId => {
        const match = allResources.find(item => item.id === resourceId);
        if (!match) throw new Error(`Unknown fixture resourceId: ${resourceId}`);
        return match;
      });
  const mountedResources = options?.mounted ?? roleResources;

  const base = sessionInput();
  const input: PiOpenInput = {
    ...base,
    lock: structuredClone(lockRes.value),
    policy: {
      ...structuredClone(base.policy),
      limits: structuredClone(MAX_LIMITS),
      resources: structuredClone([PREAMBLE_IDENTITY, ...roleResources.map(item => item.identity)]),
    },
    resources: mountedResources.map(toMountedResource),
  };

  return { resBase, resTs, resRepair, lock: lockRes.value, input };
}

test('prepareInput strips optional when during ResourceIdentity matching for unrestricted and role-scoped roles', () => {
  // 1. role.resourceIds === undefined with conditional resources in TaskContract.
  const unrestricted = makeConditionalFixture();
  const preparedAll = prepareInput(unrestricted.input);
  assert.equal(preparedAll.policy.resources.length, 4);
  assert.equal(preparedAll.resources.length, 3);
  assert.deepEqual(
    preparedAll.policy.resources.map(item => Object.keys(item).sort()),
    Array.from({ length: 4 }, () => ['digest', 'id', 'kind', 'path']),
  );

  // policy.resources itself must never accept extra `when` keys.
  const policyWithWhen = structuredClone(unrestricted.input.policy) as unknown as {
    resources: Record<string, unknown>[];
  };
  policyWithWhen.resources[2]!.when = { phases: ['repair'] };
  assert.throws(
    () => prepareInput({ ...unrestricted.input, policy: policyWithWhen }),
    err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
  );

  // 2. role.resourceIds !== undefined with conditional resources and null-prototype owned entries.
  const scoped = makeConditionalFixture({ roleResourceIds: ['res-base', 'res-repair'] });
  const nullProtoResources = scoped.input.resources.map(item => Object.assign(Object.create(null) as Record<string, unknown>, {
    id: item.id,
    kind: item.kind,
    ref: Object.assign(Object.create(null) as Record<string, unknown>, {
      name: item.ref.name,
      byteLength: item.ref.byteLength,
      digest: Object.assign(Object.create(null) as Record<string, unknown>, item.ref.digest),
    }),
    bytes: Buffer.from(item.bytes),
  }));
  const preparedScoped = prepareInput({ ...scoped.input, resources: nullProtoResources });
  assert.equal(preparedScoped.policy.resources.length, 3);
  assert.equal(preparedScoped.resources.length, 2);
});

test('prepareInput admits empty, partial, and full ordered resource subsets and enforces prompt and artifact byte caps', () => {
  const { resBase, resTs, resRepair, input } = makeConditionalFixture();

  // Empty subset is admitted when every admitted resource is conditional (has `when`)
  const allConditional = makeConditionalFixture({ roleResourceIds: ['res-ts', 'res-repair'] });
  const emptyPrepared = prepareInput({ ...allConditional.input, resources: [] });
  assert.equal(emptyPrepared.resources.length, 0);
  assert.equal(systemPrompt(emptyPrepared), HOST_PREAMBLE + '\n');

  // Single conditional subset when role admits only conditional resources
  const singlePrepared = prepareInput({ ...allConditional.input, resources: [toMountedResource(allConditional.resTs)] });
  const singlePrompt = systemPrompt(singlePrepared);
  assert.match(singlePrompt, /TypeScript files must use strict ESM NodeNext imports/);
  assert.equal(singlePrompt.includes('res-base'), false);
  assert.equal(singlePrompt.includes('res-repair'), false);

  // Partial subset (unconditional first + conditional third, skipping middle)
  const partialPrepared = prepareInput({ ...input, resources: [toMountedResource(resBase), toMountedResource(resRepair)] });
  const partialPrompt = systemPrompt(partialPrepared);
  assert.match(partialPrompt, /Always preserve deterministic repository invariants/);
  assert.match(partialPrompt, /Inspect failing verify receipts before modifying code/);
  assert.equal(partialPrompt.includes('TypeScript files must use strict ESM NodeNext imports'), false);
  assert.ok(
    partialPrompt.indexOf('res-base') < partialPrompt.indexOf('res-repair'),
    'mounted subset order must be preserved',
  );

  // Role-scoped subset keeping unconditional resBase while omitting conditional resRepair
  const scoped = makeConditionalFixture({ roleResourceIds: ['res-base', 'res-repair'] });
  const scopedBaseOnly = prepareInput({ ...scoped.input, resources: [toMountedResource(scoped.resBase)] });
  const scopedPrompt = systemPrompt(scopedBaseOnly);
  assert.match(scopedPrompt, /Always preserve deterministic repository invariants/);
  assert.equal(scopedPrompt.includes('Inspect failing verify receipts'), false);

  // maxRequestBytes (CONTEXT_UNSAFE) enforced against the actual mounted subset
  const baseOnly = prepareInput({ ...input, resources: [toMountedResource(resBase)] });
  const basePromptBytes = Buffer.byteLength(systemPrompt(baseOnly));
  const tightContextInput = {
    ...input,
    policy: {
      ...structuredClone(input.policy),
      context: { ...structuredClone(input.policy.context), maxRequestBytes: basePromptBytes },
    },
  };
  assert.ok(prepareInput({ ...tightContextInput, resources: [toMountedResource(resBase)] }));
  assert.throws(
    () => prepareInput({ ...tightContextInput, resources: [toMountedResource(resBase), toMountedResource(resTs)] }),
    err => err instanceof PiFailure && err.detail.code === 'CONTEXT_UNSAFE' && err.detail.path === '/resources',
  );

  // artifactBytes (OUTPUT_LIMIT) enforced against the actual mounted subset
  const candidateBytes = input.candidate.artifacts.reduce(
    (sum, item) => sum + ('bytes' in item ? item.bytes.byteLength : item.byteLength),
    0,
  );
  const tightArtifactBytes = candidateBytes + input.policy.limits.sessionBytes + resBase.bytes.byteLength;
  const tightArtifactInput = {
    ...input,
    policy: {
      ...structuredClone(input.policy),
      limits: { ...structuredClone(input.policy.limits), artifactBytes: tightArtifactBytes },
    },
  };
  assert.ok(prepareInput({ ...tightArtifactInput, resources: [toMountedResource(resBase)] }));
  assert.throws(
    () => prepareInput({ ...tightArtifactInput, resources: [toMountedResource(resBase), toMountedResource(resTs)] }),
    err => err instanceof PiFailure && err.detail.code === 'OUTPUT_LIMIT' && err.detail.path === '/artifacts',
  );
});

test('prepareInput rejects duplicate, out-of-order, unknown, unadmitted, and tampered resources with RESOURCE_MISMATCH', () => {
  const { resBase, resTs, resRepair, input } = makeConditionalFixture();
  const expectMismatch = (candidateInput: unknown, expectedPath?: string) => {
    assert.throws(
      () => prepareInput(candidateInput),
      err => err instanceof PiFailure
        && err.detail.code === 'RESOURCE_MISMATCH'
        && (expectedPath === undefined || err.detail.path === expectedPath),
    );
  };

  // Omitting an unconditional (`when === undefined`) admitted resource fails closed
  expectMismatch({ ...input, resources: [] }, '/resources');
  expectMismatch({ ...input, resources: [toMountedResource(resTs)] }, '/resources');

  // Duplicate ID within admitted length
  expectMismatch({ ...input, resources: [toMountedResource(resBase), toMountedResource(resBase)] }, '/resources/1');

  // Duplicate ID exceeding admitted length
  expectMismatch(
    { ...input, resources: [toMountedResource(resBase), toMountedResource(resTs), toMountedResource(resRepair), toMountedResource(resRepair)] },
    '/resources',
  );

  // Out-of-order subset
  expectMismatch({ ...input, resources: [toMountedResource(resRepair), toMountedResource(resBase)] }, '/resources/1');
  expectMismatch(
    { ...input, resources: [toMountedResource(resBase), toMountedResource(resRepair), toMountedResource(resTs)] },
    '/resources/2',
  );

  // Unknown resource ID (and prototype key / preamble ID)
  const unknown = makeFixtureResource('res-unknown', 'instruction', 'docs/unknown.md', 'Unknown\n');
  expectMismatch({ ...input, resources: [toMountedResource(unknown)] }, '/resources/0');
  const protoId = { ...toMountedResource(resBase), id: '__proto__' };
  expectMismatch({ ...input, resources: [protoId] }, '/resources/0');
  const preambleAsResource = { ...toMountedResource(resBase), id: PREAMBLE_IDENTITY.id };
  expectMismatch({ ...input, resources: [preambleAsResource] }, '/resources/0');

  // Unadmitted resource ID (present in contract, excluded from role.resourceIds)
  const scoped = makeConditionalFixture({ roleResourceIds: ['res-base', 'res-repair'] });
  expectMismatch({ ...scoped.input, resources: [toMountedResource(scoped.resTs)] }, '/resources/0');

  // Tampered kind
  expectMismatch({ ...input, resources: [{ ...toMountedResource(resBase), kind: 'skill' }] }, '/resources/0');

  // Tampered path (ref.name)
  const wrongPath = makeFixtureResource('res-base', 'instruction', 'docs/other.md', 'Always preserve deterministic repository invariants.\n');
  expectMismatch({ ...input, resources: [toMountedResource(wrongPath)] }, '/resources/0');

  // Tampered digest
  const baseMounted = toMountedResource(resBase);
  const badDigest = {
    ...baseMounted,
    ref: { ...baseMounted.ref, digest: { algorithm: 'sha256' as const, hex: '0'.repeat(64) } },
  };
  expectMismatch({ ...input, resources: [badDigest] }, '/resources/0');

  // Tampered bytes (ref matches admitted, bytes mutated)
  const badBytes = {
    ...toMountedResource(resBase),
    bytes: Buffer.from('Tampered resource content\n', 'utf8'),
  };
  expectMismatch({ ...input, resources: [badBytes] }, '/resources/0');
});

test('recoverSnapshot and nativeSessionId remain invariant across author, repair, and compaction sessions mounting different resource subsets', async () => {
  const frames = [
    { type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const timestamp = '2026-11-21T00:00:00.000Z';

  const fixtureData = makeConditionalFixture({ runId: 'run-restore-subset-1', admissionId: 'admission-restore-subset-1' });
  const pinnedPolicyCanonical = canonical(fixtureData.input.policy);

  // Author turn starts with only the unconditional resource mounted.
  const authorBaseInput: PiOpenInput = {
    ...fixtureData.input,
    resources: [toMountedResource(fixtureData.resBase)],
  };

  const f = await requestFixture(
    () => ({ status: 200, body: frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('') }),
    () => authorBaseInput,
    10000,
  );

  const observedPrompts: string[] = [];
  const ports: FactoryPorts = {
    environment: async () => {},
    sender: (host, input) => new Sender(host, input, { fetch: (_url, init) => globalThis.fetch(f.destination, init) }),
    session: (_host, input, broker, directory) => ({
      start: async (): Promise<PiCapabilities> => {
        await mkdir(directory, { mode: 0o700 });
        for (const artifact of input.candidate.artifacts) {
          await mkdir(join(directory, 'candidate', artifact.name, '..'), { recursive: true, mode: 0o755 });
          if ('bytes' in artifact) await writeFile(join(directory, 'candidate', artifact.name), artifact.bytes, { mode: 0o444 });
        }
        return {
          version: 1,
          policyDigest: digest(Buffer.from(canonical(input.policy))),
          runtime: input.policy.runtime,
          requested: input.policy.selection,
          catalogSupported: input.policy.selection,
          sessionEffective: input.policy.selection,
          outboundObserved: null,
          resources: input.policy.resources,
          accounting: 'soft_only',
          contextFit: 'unproven',
          defaultMode: 'proven_bound',
          liveProvenBoundAvailable: false,
          optInMode: 'estimated_guard',
          contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' },
          toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' },
        };
      },
      command: async () => {
        const prompt = systemPrompt(input);
        observedPrompts.push(prompt);
        const grant = await broker.invoke({ invocation: 1, ...input.policy.selection });
        await broker.send(
          {
            invocation: 1,
            slot: grant.slot,
            method: 'POST',
            url: PROVIDER_DESTINATION,
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              'x-initiator': 'user',
              'openai-intent': 'conversation-edits',
            },
          },
          Buffer.from(JSON.stringify({
            model: input.policy.selection.model,
            system: [{ type: 'text', text: prompt + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }],
            messages: [{ role: 'user', content: 'literal task' }],
            stream: true,
            max_tokens: 1024,
            thinking: { type: 'adaptive' },
            output_config: { effort: 'xhigh' },
          })),
        );
        await broker.parsed({
          invocation: 1,
          slot: grant.slot,
          stopReason: 'stop',
          rawStopReason: 'end_turn',
          usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 },
          toolCalls: [],
        });
      },
      capture: async (sink: (bytes: Uint8Array) => Promise<void>) => {
        for (const entry of [
          { type: 'session', version: 3, id: 'native-session', cwd: '/workspace/candidate', timestamp },
          { type: 'message', id: 'entry-1', parentId: null, timestamp, message: { role: 'user', content: 'literal task' } },
          {
            type: 'message',
            id: 'entry-2',
            parentId: 'entry-1',
            timestamp,
            message: {
              role: 'assistant',
              model: input.policy.selection.model,
              provider: input.policy.selection.provider,
              api: input.policy.selection.api,
              content: [{ type: 'text', text: 'DONE' }],
              stopReason: 'stop',
            },
          },
        ]) {
          await sink(rowBytes(entry));
        }
      },
      close: async () => {},
    }),
  };

  try {
    // Turn 1: Author session mounts subset A = [res-base].
    const authorOpened = await constructAdapter(f.host, f.input, ports);
    assert.equal(authorOpened.ok, true, JSON.stringify(authorOpened.ok ? null : authorOpened.error));
    if (!authorOpened.ok) throw new Error('author open failed');
    const authorAdapter = authorOpened.value;

    const authorPolicyDigest = authorAdapter.capabilities().policyDigest;
    assert.equal(authorAdapter.capabilities().resources.length, 4);
    assert.equal((await authorAdapter.execute({ commandId: 'author-1', text: 'author task', purpose: 'task', repair: 'none' })).ok, true);
    const cp1 = await authorAdapter.capture({ checkpointId: 'checkpoint-author-1' });
    assert.equal(cp1.ok, true, JSON.stringify(cp1.ok ? null : cp1.error));
    if (!cp1.ok) throw new Error('author capture failed');
    assert.equal((await authorAdapter.close()).ok, true);

    assert.equal(observedPrompts.length, 1);
    assert.match(observedPrompts[0]!, /res-base/);
    assert.equal(observedPrompts[0]!.includes('res-ts'), false);
    assert.equal(observedPrompts[0]!.includes('res-repair'), false);

    // Turn 2: Repair session restores checkpoint-author-1 while mounting subset B = [res-base, res-ts, res-repair].
    const repairInput: PiOpenInput = {
      ...f.input,
      candidate: { ...f.input.candidate, manifest: cp1.value.candidate },
      resources: [
        toMountedResource(fixtureData.resBase),
        toMountedResource(fixtureData.resTs),
        toMountedResource(fixtureData.resRepair),
      ],
      restore: {
        checkpointId: 'checkpoint-author-1',
        workspace: { ref: cp1.value.workspace, bytes: await readFile(join(f.host.artifactsDirectory, cp1.value.workspace.name)) },
        session: { ref: cp1.value.session, bytes: await readFile(join(f.host.artifactsDirectory, cp1.value.session.name)) },
      },
    };
    assert.equal(canonical(repairInput.policy), pinnedPolicyCanonical);

    await mkdir(join(f.directory, 'repair-runtime'));
    const repairOpened = await constructAdapter({ ...f.host, directory: join(f.directory, 'repair-runtime') }, repairInput, ports);
    assert.equal(repairOpened.ok, true, JSON.stringify(repairOpened.ok ? null : repairOpened.error));
    if (!repairOpened.ok) throw new Error('repair restore open failed');
    const repairAdapter = repairOpened.value;

    assert.equal(canonical(repairAdapter.capabilities().policyDigest), canonical(authorPolicyDigest));
    assert.equal((await repairAdapter.execute({ commandId: 'repair-1', text: 'fix verify failure', purpose: 'task', repair: 'implementation' })).ok, true);
    const cp2 = await repairAdapter.capture({ checkpointId: 'checkpoint-repair-1' });
    assert.equal(cp2.ok, true, JSON.stringify(cp2.ok ? null : cp2.error));
    if (!cp2.ok) throw new Error('repair capture failed');
    assert.equal((await repairAdapter.close()).ok, true);

    assert.equal(observedPrompts.length, 2);
    assert.match(observedPrompts[1]!, /res-base/);
    assert.match(observedPrompts[1]!, /res-ts/);
    assert.match(observedPrompts[1]!, /res-repair/);

    // Turn 3: Compaction restore mounts subset C = [res-base] (unconditional only, conditional rules omitted) under the same pinned full policy.resources.
    const compactionInput: PiOpenInput = {
      ...f.input,
      candidate: { ...f.input.candidate, manifest: cp2.value.candidate },
      resources: [toMountedResource(fixtureData.resBase)],
      restore: {
        checkpointId: 'checkpoint-repair-1',
        workspace: { ref: cp2.value.workspace, bytes: await readFile(join(f.host.artifactsDirectory, cp2.value.workspace.name)) },
        session: { ref: cp2.value.session, bytes: await readFile(join(f.host.artifactsDirectory, cp2.value.session.name)) },
      },
    };
    assert.equal(canonical(compactionInput.policy), pinnedPolicyCanonical);

    const preparedCompaction = prepareInput(compactionInput);
    const recovered = await recoverSnapshot(f.host, preparedCompaction);
    assert.ok(recovered !== null && recovered.native.byteLength > 0);

    await mkdir(join(f.directory, 'compaction-runtime'));
    const compactionOpened = await constructAdapter({ ...f.host, directory: join(f.directory, 'compaction-runtime') }, compactionInput, ports);
    assert.equal(compactionOpened.ok, true, JSON.stringify(compactionOpened.ok ? null : compactionOpened.error));
    if (compactionOpened.ok) {
      assert.equal(canonical(compactionOpened.value.capabilities().policyDigest), canonical(authorPolicyDigest));
      assert.equal(stateGood(f.host.store.inspect()).counts.requests, 2);
      await compactionOpened.value.close();
    }

    // Mutating pinned policy.resources still fails closed (never silently weakens binding verification).
    const mutatedPolicy = {
      ...compactionInput,
      policy: {
        ...structuredClone(compactionInput.policy),
        resources: compactionInput.policy.resources.slice(0, 2),
      },
    };
    await assert.rejects(
      () => recoverSnapshot(f.host, mutatedPolicy),
      err => err instanceof PiFailure && err.detail.code === 'BINDING_MISMATCH',
    );
  } finally {
    await f.cleanup();
  }
});
