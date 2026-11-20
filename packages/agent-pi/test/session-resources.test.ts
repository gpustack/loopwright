import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitTask, digestArtifact } from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import { PiFailure } from '../src/errors.js';
import { MAX_LIMITS } from '../src/policy.js';
import { PREAMBLE_IDENTITY, frozenLoader, systemPrompt } from '../src/resources.js';
import { prepareInput } from '../src/preflight.js';
import { sessionInput } from './session-fixtures.js';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';

test('literal loader has no discovery, append, skill, prompt or theme authority', async () => {
  const prompt = systemPrompt(prepareInput(sessionInput()));
  const extensions = { extensions: [], errors: [], runtime: {} } as unknown as ReturnType<ResourceLoader['getExtensions']>;
  const loader = frozenLoader(prompt, extensions);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []); assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getSkills().skills, []); assert.deepEqual(loader.getPrompts().prompts, []); assert.deepEqual(loader.getThemes().themes, []);
  assert.equal(loader.getSystemPromptSource(), undefined); assert.deepEqual(loader.getAppendSystemPromptSources(), []);
  assert.throws(() => loader.extendResources({ skillPaths: [] })); await loader.reload(); assert.equal(loader.getSystemPrompt(), prompt);
});

test('final loader reload refuses changed native snapshot without rediscovery', async () => {
  const extensions = { extensions: [], errors: [], runtime: {} } as unknown as ReturnType<ResourceLoader['getExtensions']>;
  const loader = frozenLoader('literal', extensions);
  await loader.reload(); assert.equal(loader.getExtensions(), extensions);
  extensions.errors.push({ path: '<inline:unexpected>', error: 'changed after bootstrap' });
  await assert.rejects(loader.reload(), /snapshot/);
});

test('systemPrompt rejects invalid UTF-8 and NUL binary bytes with deterministic RESOURCE_MISMATCH refusal instead of TypeError', () => {
  const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0x80, 0x81]);
  const badRef = digestArtifact('docs/corrupt.bin', invalidUtf8);
  assert.equal(badRef.ok, true);
  if (!badRef.ok) throw new Error('badRef failed');

  assert.throws(
    () => systemPrompt({
      resources: [{ id: 'corrupt-doc', kind: 'document', ref: badRef.value, bytes: invalidUtf8 }],
    }),
    err => err instanceof PiFailure && err.detail.code === 'RESOURCE_MISMATCH' && err.detail.path === '/resources/0',
  );

  const nulBytes = new Uint8Array([0x68, 0x69, 0x00, 0x21]);
  const nulRef = digestArtifact('docs/null-byte.bin', nulBytes);
  assert.equal(nulRef.ok, true);
  if (!nulRef.ok) throw new Error('nulRef failed');

  assert.throws(
    () => systemPrompt({
      resources: [{ id: 'nul-doc', kind: 'document', ref: nulRef.value, bytes: nulBytes }],
    }),
    err => err instanceof PiFailure && err.detail.code === 'RESOURCE_MISMATCH' && err.detail.path === '/resources/0',
  );
});

test('systemPrompt and prepareInput enforce per-role resourceIds filtering while leaving workspace binaries untouched', () => {
  const resABytes = Buffer.from('Instruction A for role A only\n', 'utf8');
  const resBBytes = Buffer.from('Instruction B for role B only\n', 'utf8');
  const invalidBinaryBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0xfa]);
  const resARef = digestArtifact('docs/a.md', resABytes);
  const resBRef = digestArtifact('docs/b.md', resBBytes);
  const binArtifactRef = digestArtifact('packages/cache.tgz', invalidBinaryBytes);
  assert.equal(resARef.ok && resBRef.ok && binArtifactRef.ok, true);
  if (!resARef.ok || !resBRef.ok || !binArtifactRef.ok) throw new Error('artifact digest failed');

  // 1. Direct systemPrompt filtering via explicit resourceIds option (never decodes excluded binary entry).
  const filteredPrompt = systemPrompt(
    {
      resources: [
        { id: 'res-a', kind: 'instruction', ref: resARef.value, bytes: resABytes },
        { id: 'res-bin', kind: 'document', ref: binArtifactRef.value, bytes: invalidBinaryBytes },
      ],
    },
    { resourceIds: ['res-a'] },
  );
  assert.match(filteredPrompt, /Instruction A for role A only/);
  assert.equal(filteredPrompt.includes('res-bin'), false);

  // 2. Empty resourceIds yields preamble only.
  const emptyPrompt = systemPrompt(
    { resources: [{ id: 'res-a', kind: 'instruction', ref: resARef.value, bytes: resABytes }] },
    { resourceIds: [] },
  );
  assert.equal(emptyPrompt.includes('Instruction A'), false);

  // 3. TaskContract with role.resourceIds and a binary workspace file (not in trustedContext.resources).
  const base = sessionInput();
  const resourceEntries = [
    { id: 'res-a', kind: 'instruction' as const, path: resARef.value.name, digest: resARef.value.digest },
    { id: 'res-b', kind: 'instruction' as const, path: resBRef.value.name, digest: resBRef.value.digest },
  ];
  const task = contract();
  task.spec.roles[0]!.model = 'claude-sonnet-5.5';
  task.spec.roles[0]!.thinking = 'xhigh';
  task.spec.roles[0]!.tools = ['read'];
  (task.spec.roles[0] as unknown as { resourceIds?: readonly string[] }).resourceIds = ['res-a'];
  (task.spec.trustedContext as unknown as { resources: typeof resourceEntries }).resources = resourceEntries;
  task.spec.budgets.wallTimeMs = 60000;
  task.spec.budgets.totalTokens = 1000000;
  task.spec.budgets.perCallOutputTokens = 1024;
  const lockRes = admitTask(task, { admissionId: 'admission-res-1', runId: 'run-res-1' });
  assert.equal(lockRes.ok, true);
  if (!lockRes.ok) throw new Error('admitTask failed');

  const inputForRoleA = {
    ...base,
    lock: structuredClone(lockRes.value),
    policy: {
      ...structuredClone(base.policy),
      limits: structuredClone(MAX_LIMITS),
      resources: structuredClone([PREAMBLE_IDENTITY, resourceEntries[0]!]),
    },
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1' as const,
        kind: 'ArtifactManifest' as const,
        metadata: { id: 'candidate' },
        spec: { entries: [structuredClone(binArtifactRef.value)] },
      },
      baseRevision: task.spec.target.baseRevision,
      sourceRevision: task.spec.target.sourceRevision,
      artifacts: [{ name: binArtifactRef.value.name, bytes: invalidBinaryBytes }],
    },
    resources: [{ id: 'res-a', kind: 'instruction' as const, ref: structuredClone(resARef.value), bytes: resABytes }],
  };

  const prepared = prepareInput(inputForRoleA);
  const rolePrompt = systemPrompt(prepared);
  assert.match(rolePrompt, /Instruction A for role A only/);
  assert.equal(rolePrompt.includes('Instruction B for role B only'), false);

  // 4. Passing an unauthorized resource outside role.resourceIds fails closed in prepareInput.
  const unauthorizedInput = {
    ...inputForRoleA,
    lock: structuredClone(lockRes.value),
    policy: {
      ...structuredClone(inputForRoleA.policy),
      resources: structuredClone([PREAMBLE_IDENTITY, ...resourceEntries]),
    },
    resources: [
      { id: 'res-a', kind: 'instruction' as const, ref: structuredClone(resARef.value), bytes: resABytes },
      { id: 'res-b', kind: 'instruction' as const, ref: structuredClone(resBRef.value), bytes: resBBytes },
    ],
  };
  assert.throws(
    () => prepareInput(unauthorizedInput),
    err => err instanceof PiFailure && err.detail.code === 'RESOURCE_MISMATCH',
  );

  // 5. Omitting role.resourceIds preserves all trustedContext.resources.
  const taskAll = contract();
  taskAll.spec.roles[0]!.model = 'claude-sonnet-5.5';
  taskAll.spec.roles[0]!.thinking = 'xhigh';
  taskAll.spec.roles[0]!.tools = ['read'];
  (taskAll.spec.trustedContext as unknown as { resources: typeof resourceEntries }).resources = structuredClone(resourceEntries);
  taskAll.spec.budgets.wallTimeMs = 60000;
  taskAll.spec.budgets.totalTokens = 1000000;
  taskAll.spec.budgets.perCallOutputTokens = 1024;
  const lockAll = admitTask(taskAll, { admissionId: 'admission-res-all', runId: 'run-res-all' });
  assert.equal(lockAll.ok, true);
  if (!lockAll.ok) throw new Error('admitTask all failed');

  const preparedAll = prepareInput({
    ...base,
    lock: structuredClone(lockAll.value),
    policy: {
      ...structuredClone(base.policy),
      limits: structuredClone(MAX_LIMITS),
      resources: structuredClone([PREAMBLE_IDENTITY, ...resourceEntries]),
    },
    resources: [
      { id: 'res-a', kind: 'instruction' as const, ref: structuredClone(resARef.value), bytes: resABytes },
      { id: 'res-b', kind: 'instruction' as const, ref: structuredClone(resBRef.value), bytes: resBBytes },
    ],
  });
  const allPrompt = systemPrompt(preparedAll);
  assert.match(allPrompt, /Instruction A for role A only/);
  assert.match(allPrompt, /Instruction B for role B only/);

  // 6. Unknown roleId with input.lock present refuses BINDING_MISMATCH rather than silently falling back to all resources.
  assert.throws(
    () => systemPrompt({
      lock: structuredClone(lockRes.value),
      roleId: 'nonexistent-role',
      resources: [
        { id: 'res-a', kind: 'instruction', ref: structuredClone(resARef.value), bytes: resABytes },
        { id: 'res-b', kind: 'instruction', ref: structuredClone(resBRef.value), bytes: resBBytes },
      ],
    }),
    err => err instanceof PiFailure && err.detail.code === 'BINDING_MISMATCH' && err.detail.path === '/roleId',
  );

  // 7. Proxy arrays and getter-backed elements in options.resourceIds fail closed with INPUT_INVALID without invoking traps.
  assert.throws(
    () => systemPrompt(
      { resources: [{ id: 'res-a', kind: 'instruction', ref: structuredClone(resARef.value), bytes: resABytes }] },
      { resourceIds: new Proxy(['res-a'], {}) },
    ),
    err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
  );
  let getterRan = false;
  const getterIds: string[] = [];
  Object.defineProperty(getterIds, '0', {
    enumerable: true,
    get() {
      getterRan = true;
      return 'res-a';
    },
  });
  getterIds.length = 1;
  assert.throws(
    () => systemPrompt(
      { resources: [{ id: 'res-a', kind: 'instruction', ref: structuredClone(resARef.value), bytes: resABytes }] },
      { resourceIds: getterIds },
    ),
    err => err instanceof PiFailure && err.detail.code === 'INPUT_INVALID',
  );
  assert.equal(getterRan, false);
});
