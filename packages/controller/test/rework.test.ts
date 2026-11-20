import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SecretScrubber } from '@loopwright/core';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInputV2, PiOutcomeV2 } from '@loopwright/agent-pi';
import {
  formatRunReport,
  inspectRun,
  installedHandlerDigests,
  parseStepVerdict,
  parseSubmission,
  reconcileCycle,
  resumeCycleWithPorts,
  runCycleWithPorts,
  signPayload,
  stepNext,
  stepSubmit,
  type StepTickResult,
  type StepVerdict,
  type StepYield,
} from '../src/index.js';
import { reworkSubgraph, resetSubgraphNodes } from '../src/scheduler.js';
import { matchesScopePattern } from '../src/source.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { phaseCheckpointId, stableId, validateProgress } from '../src/progress.js';
import { packetFixture } from './verification-fixtures.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';
import { configurationFixture } from './config-fixtures.js';

function assertOk<T>(res: { readonly ok: boolean; readonly value?: T; readonly error?: unknown }, msg = ''): T {
  assert.equal(res.ok, true, `${msg}: ${JSON.stringify(res.error)}`);
  return res.value as T;
}

function assertStepYield(tick: StepTickResult, msg = ''): StepYield {
  assert.equal(tick.kind, 'step', `${msg}: expected step yield, got ${JSON.stringify(tick)}`);
  if (tick.kind !== 'step') throw new Error('expected step');
  return tick;
}

test('parseStepVerdict validates StepVerdict strictly alongside parseSubmission', () => {
  const task = packetFixture().lock.spec.contract;
  const subBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      status: 'completed',
      checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
      reason: null,
    }),
    'utf8',
  );
  const sub = parseSubmission(subBytes, task);
  assert.equal(sub.status, 'completed');
  assert.equal(sub.checks.length, 1);

  const validVerdict: StepVerdict = {
    verdict: 'rework',
    summary: 'Implementation missed edge-case null check.',
    findings: [
      {
        title: 'Null guard missing',
        severity: 'high',
        path: 'packages/result.json',
        line: 4,
        evidence: 'ok property is unguarded',
      },
      {
        title: 'Minor doc note',
        severity: 'low',
        evidence: 'Update changelog entry',
      },
    ],
  };
  const parsedDirect = parseStepVerdict(Buffer.from(JSON.stringify(validVerdict), 'utf8'));
  assert.equal(parsedDirect.verdict, 'rework');
  assert.equal(parsedDirect.summary, validVerdict.summary);
  assert.equal(parsedDirect.findings.length, 2);
  assert.equal(parsedDirect.findings[0]?.path, 'packages/result.json');
  assert.equal(parsedDirect.findings[0]?.line, 4);
  assert.equal(Object.hasOwn(parsedDirect.findings[1]!, 'path'), false);

  const fenced = Buffer.from('```json\n' + JSON.stringify({ verdict: 'pass', summary: 'LGTM', findings: [] }) + '\n```', 'utf8');
  assert.deepEqual(parseStepVerdict(fenced), { verdict: 'pass', summary: 'LGTM', findings: [] });

  for (const invalid of [
    '',
    '{}',
    JSON.stringify({ verdict: 'approved', summary: 'wrong enum', findings: [] }),
    JSON.stringify({ verdict: 'pass', summary: '', findings: [] }),
    JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [], extra: 1 }),
    JSON.stringify({
      verdict: 'rework',
      summary: 'bad path',
      findings: [{ title: 't', severity: 'high', path: '../escape.ts', evidence: 'e' }],
    }),
    JSON.stringify({
      verdict: 'rework',
      summary: 'bad line',
      findings: [{ title: 't', severity: 'high', line: 0, evidence: 'e' }],
    }),
    JSON.stringify(sub), // submission.v1 is NOT a StepVerdict
  ]) {
    assert.throws(() => parseStepVerdict(Buffer.from(invalid, 'utf8')));
  }
});

test('reworkSubgraph and resetSubgraphNodes reset only [rejectTo, ...descendants] and preserve outside nodes', async () => {
  const f = await retainedFixture();
  try {
    const base = f.plan.orderedDAG[0]!;
    const plan = {
      orderedDAG: [
        { ...base, id: 'plan', dependsOn: [] },
        { ...base, id: 'audit', dependsOn: ['plan'] },
        { ...base, id: 'implement', dependsOn: ['plan'] },
        { ...base, id: 'docs', dependsOn: ['implement'] },
        { ...base, id: 'fast-check', kind: 'check' as const, roleId: null, dependsOn: ['docs'] },
        { ...base, id: 'review', dependsOn: ['fast-check'] },
      ],
    };
    assert.deepEqual(reworkSubgraph(plan, 'implement'), ['implement', 'docs', 'fast-check', 'review']);
    const initialNodes = plan.orderedDAG.map(n => ({ id: n.id, state: 'completed' as const }));
    const reset = resetSubgraphNodes(plan, initialNodes, 'implement');
    assert.deepEqual(reset, [
      { id: 'plan', state: 'completed' },
      { id: 'audit', state: 'completed' },
      { id: 'implement', state: 'pending' },
      { id: 'docs', state: 'pending' },
      { id: 'fast-check', state: 'pending' },
      { id: 'review', state: 'pending' },
    ]);
  } finally {
    await f.close();
  }
});

function createPiMockPort(
  planStep: (ctx: {
    readonly stepId: string;
    readonly roleId: string;
    readonly prompt: string;
    readonly resourceIds: readonly string[];
    readonly candidateFiles: ReadonlyMap<string, Uint8Array>;
  }) => {
    readonly files?: Readonly<Record<string, string>>;
    readonly responseJson: unknown;
  },
) {
  let reqSeq = 0;
  const cancelledErr: PiErrorV2 = {
    code: 'CANCELLED',
    phase: 'session',
    path: '',
    retryable: false,
    effect: 'none',
    requestId: null,
    operationId: null,
    stateErrorCode: null,
  };
  const cancelledOut: PiOutcomeV2 = {
    status: 'cancelled',
    requestIds: [],
    operationIds: [],
    providerTermination: 'none',
    usage: 'none',
    localCleanup: 'complete',
    error: cancelledErr,
    cleanupError: null,
  };

  return async (host: PiHostV2, input: PiOpenInputV2) => {
    let lastCommandText = '';
    let lastRequestId = '';
    let lastOpId = '';
    let currentFiles = new Map<string, Uint8Array>(
      await Promise.all(
        input.candidate.artifacts.map(async a => [
          a.name,
          'bytes' in a ? new Uint8Array(a.bytes) : new Uint8Array(await readFile(a.blobPath)),
        ] as const),
      ),
    );
    let responseText = '';

    const adapter: PiAdapterV2 = {
      capabilities: () => {
        throw new Error('unused');
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          yield* [];
        },
      }),
      cancel: async () => ({ ok: true, value: cancelledOut }),
      close: async () => ({ ok: true, value: { closed: true } }),
      compact: async () => ({
        ok: true,
        value: {
          status: 'execution_settled',
          requestIds: [],
          operationIds: [],
          providerTermination: 'confirmed',
          usage: 'complete',
          localCleanup: 'complete',
          error: null,
          cleanupError: null,
        },
      }),
      execute: async cmd => {
        reqSeq++;
        lastCommandText = cmd.text;
        lastRequestId = `pi-req-${reqSeq}`;
        lastOpId = `pi-op-${reqSeq}`;
        const stepDecision = planStep({
          stepId: input.stepId,
          roleId: input.roleId,
          prompt: cmd.text,
          resourceIds: input.resources.map(r => r.id),
          candidateFiles: currentFiles,
        });
        if (stepDecision.files) {
          currentFiles = new Map(currentFiles);
          for (const [name, content] of Object.entries(stepDecision.files)) {
            currentFiles.set(name, new Uint8Array(Buffer.from(content, 'utf8')));
          }
        }
        responseText = JSON.stringify(stepDecision.responseJson);

        const mappedPurpose: 'task' | 'reviewer' | 'compaction' =
          cmd.purpose === 'reviewer' || cmd.purpose === 'compaction' ? cmd.purpose : 'task';
        stateValue(
          host.store.reserveRequest(host.authority, {
            requestId: lastRequestId,
            roleId: input.roleId,
            nodeId: input.stepId,
            attemptId: cmd.commandId,
            purpose: mappedPurpose,
            repair: cmd.repair,
            transportRetryOf: null,
            requestDigest: hash(`req-${reqSeq}`),
            inputUpperBound: 100,
            outputUpperBound: 50,
            totalUpperBound: 150,
            capability: {
              adapterId: 'pi',
              adapterVersion: '0.0.0',
              provider: input.policy.selection.provider,
              model: input.policy.selection.model,
              kind: 'soft_only',
              coversAllBillableTokens: false,
              enforcesOutputBound: false,
            },
            operationId: lastOpId,
            targetIdentity: 'fixture:pi-rework',
          }),
        );
        stateValue(host.store.authorizeRequestDispatch(host.authority, lastRequestId));
        const op = stateValue(host.store.getOperation(lastOpId));
        const view = stateValue(host.store.inspect());
        const usageBytes = Buffer.from(canonical({ seq: reqSeq }));
        const usageName = `usage-${hash(usageBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, usageName), usageBytes, { mode: 0o600 });
        const usageArtifact = { name: usageName, byteLength: usageBytes.byteLength, digest: hash(usageBytes) };
        stateValue(
          host.store.observeRequest(host.authority, lastRequestId, {
            receiptId: `rec-${reqSeq}`,
            termination: 'confirmed',
            outcome: 'succeeded',
            evidence: {
              evidenceId: `ev-${reqSeq}`,
              producerId: 'mock-pi',
              method: 'synthetic',
              artifact: usageArtifact,
              subject: {
                storeId: view.storeId,
                runId: view.runId,
                lockHash: view.lockHash,
                operationId: lastOpId,
                requestId: lastRequestId,
                intentDigest: op.intentDigest,
                dispatchGeneration: op.dispatch!.generation,
                dispatchId: op.dispatch!.dispatchId,
              },
            },
            usage: {
              requestId: lastRequestId,
              inputTokens: { provenance: 'reported', value: 20 },
              outputTokens: { provenance: 'reported', value: 10 },
              costMicrousd: { provenance: 'reported', value: 500 },
            },
          }),
        );
        return {
          ok: true,
          value: {
            status: 'execution_settled',
            requestIds: [lastRequestId],
            operationIds: [lastOpId],
            providerTermination: 'confirmed',
            usage: 'complete',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        };
      },
      capture: async ({ checkpointId }) => {
        const sortedEntries = [...currentFiles.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, bytes]) => ({
            name,
            bytes,
            ref: { name, byteLength: bytes.byteLength, digest: hash(bytes) },
          }));
        const manifest = {
          apiVersion: 'loopwright.dev/v1alpha1' as const,
          kind: 'ArtifactManifest' as const,
          metadata: { id: 'candidate' },
          spec: input.candidate.manifest.spec.baseTree
            ? {
                baseTree: input.candidate.manifest.spec.baseTree,
                entries: sortedEntries.map(e => e.ref),
                deleted: input.candidate.manifest.spec.deleted ?? [],
              }
            : { entries: sortedEntries.map(e => e.ref) },
        };
        const current = stateValue(host.store.inspect());
        const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
        const nativePolicy = {
          ...input.policy,
          version: 1,
          policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36),
        };
        const candidateDigest = hash('loopwright.dev/artifact-manifest/v1alpha1\0' + canonical(manifest));
        const binding = {
          version: 1,
          checkpointId,
          storeId: current.storeId,
          runId: current.runId,
          lockHash: current.lockHash,
          sessionId: input.sessionId,
          roleId: input.roleId,
          stepId: input.stepId,
          runtime: input.policy.runtime,
          policyDigest: hash(canonical(nativePolicy)),
          resourcesDigest: hash(canonical(input.policy.resources)),
          candidateDigest,
          clockBasis: current.clock.basis,
          accountingDigest: hash(
            canonical({
              ledger: current.ledger,
              requests: current.counts.requests,
              operations: current.counts.operations,
            }),
          ),
          sequence: 1,
        };
        const line = (v: unknown) => JSON.stringify(v) + '\n';
        let wsBody = line({ type: 'workspace_snapshot', version: 1, binding, manifest });
        for (const item of sortedEntries) {
          wsBody += line({ type: 'file', ref: item.ref });
          if (item.bytes.byteLength > 0) {
            wsBody += line({ type: 'chunk', index: 0, data: Buffer.from(item.bytes).toString('base64') });
          }
          wsBody += line({ type: 'file_end', byteLength: item.bytes.byteLength, digest: item.ref.digest.hex });
        }
        wsBody += line({ type: 'end', files: sortedEntries.length });
        const wsBytes = Buffer.from(wsBody, 'utf8');
        const wsName = `ws-${hash(wsBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
        const workspaceRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };

        const ts = '2026-11-19T00:00:00.000Z';
        const sessBody =
          line({ type: 'session_snapshot', version: 1, binding }) +
          line({ type: 'session', version: 3, id: 'sess_1', cwd: '/workspace/candidate', timestamp: ts }) +
          line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastCommandText } }) +
          line({
            type: 'message',
            id: 'a1',
            parentId: 'u1',
            timestamp: ts,
            message: {
              role: 'assistant',
              ...input.policy.selection,
              content: [{ type: 'text', text: responseText }],
              stopReason: 'stop',
            },
          });
        const sessBytes = Buffer.from(sessBody, 'utf8');
        const sessName = `sess-${hash(sessBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
        const sessionRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };

        stateValue(
          host.store.writeCheckpoint(host.authority, {
            checkpointId,
            expectedRevision: stateValue(host.store.inspect()).revision,
            candidateManifest: manifest,
            workspace: workspaceRef,
            privateSession: sessionRef,
            additionalArtifacts: [],
          }),
        );
        return {
          ok: true,
          value: { checkpointId, candidate: manifest, workspace: workspaceRef, session: sessionRef },
        };
      },
    };
    return { ok: true as const, value: adapter };
  };
}

async function setupFiveStepPiFixture(maxReworks = 2) {
  const f = await configurationFixture();
  const repository = join(f.root, 'repository');
  const runRoot = join(f.root, 'runs');
  await mkdir(join(repository, 'packages'), { recursive: true, mode: 0o700 });
  await mkdir(join(repository, 'docs'), { recursive: true, mode: 0o700 });
  await writeFile(join(repository, 'packages', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
  await writeFile(join(repository, 'docs', 'guide.md'), '# Guide\n', { mode: 0o600 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repository,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
    });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Rework Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'baseline']);
  const rev = git(['rev-parse', 'HEAD']).trim();

  const resPlanBytes = Buffer.from('Planner instructions only.\n', 'utf8');
  const resImplBytes = Buffer.from('Implementer instructions only.\n', 'utf8');
  const resPlan = { id: 'plan-doc', kind: 'instruction' as const, path: 'plan.md', digest: hash(resPlanBytes) };
  const resImpl = { id: 'impl-doc', kind: 'instruction' as const, path: 'impl.md', digest: hash(resImplBytes) };
  await writeFile(join(f.operator, resPlan.path), resPlanBytes, { mode: 0o600 });
  await writeFile(join(f.operator, resImpl.path), resImplBytes, { mode: 0o600 });

  const installed = await installedHandlerDigests();
  const baseProfile = f.registry.spec.roleProfiles[0]!;
  const writeProfile = { ...baseProfile, id: 'writer', tools: ['read', 'write', 'edit'] };
  const readProfile = { ...baseProfile, id: 'reader', tools: ['read'] };

  setFixture(f.registry, ['spec', 'resources'], [resPlan, resImpl]);
  setFixture(f.registry, ['spec', 'roleProfiles'], [readProfile, writeProfile]);
  setFixture(f.registry, ['spec', 'handlers'], [
    {
      id: 'plan.h',
      kind: 'agent',
      implementation: 'pi.agent.v1',
      version: 1,
      digest: installed['pi.agent.v1'],
      parameters: { prompt: 'Create implementation plan.', purpose: 'task' },
      capabilities: ['pi'],
    },
    {
      id: 'impl.h',
      kind: 'agent',
      implementation: 'pi.agent.v1',
      version: 1,
      digest: installed['pi.agent.v1'],
      parameters: { prompt: 'Implement changes.', purpose: 'task' },
      capabilities: ['pi'],
    },
    {
      id: 'docs.h',
      kind: 'agent',
      implementation: 'pi.agent.v1',
      version: 1,
      digest: installed['pi.agent.v1'],
      parameters: { prompt: 'Update documentation.', purpose: 'task' },
      capabilities: ['pi'],
    },
    {
      id: 'tests',
      kind: 'check',
      implementation: 'json-artifact.v1',
      version: 1,
      digest: installed['json-artifact.v1'],
      parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } },
      capabilities: ['inert_bytes', 'read_only'],
    },
    {
      id: 'review.h',
      kind: 'agent',
      implementation: 'pi.agent.v1',
      version: 1,
      digest: installed['pi.agent.v1'],
      parameters: { prompt: 'Review diff and return StepVerdict.', purpose: 'review' },
      capabilities: ['pi'],
    },
    ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
  ]);

  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
  setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
    writable: ['packages/**', 'docs/**'],
    protected: [],
  });
  setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [resPlan, resImpl]);
  setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
    { id: 'planner', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read'], resourceIds: ['plan-doc'] },
    { id: 'implementer', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read', 'write', 'edit'], resourceIds: ['impl-doc'] },
    { id: 'documenter', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read', 'write'], resourceIds: [] },
    { id: 'reviewer', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read'], resourceIds: [] },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'roles'], [
    { roleId: 'planner', profileRef: 'reader' },
    { roleId: 'implementer', profileRef: 'writer' },
    { roleId: 'documenter', profileRef: 'writer' },
    { roleId: 'reviewer', profileRef: 'reader' },
  ]);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
    { id: 'plan', kind: 'agent', uses: 'plan.h', roleId: 'planner', dependsOn: [] },
    { id: 'implement', kind: 'agent', uses: 'impl.h', roleId: 'implementer', dependsOn: ['plan'] },
    { id: 'docs', kind: 'agent', uses: 'docs.h', roleId: 'documenter', dependsOn: ['implement'] },
    { id: 'fast-check', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['docs'] },
    {
      id: 'review',
      kind: 'agent',
      uses: 'review.h',
      roleId: 'reviewer',
      dependsOn: ['fast-check'],
      onRework: { rejectTo: 'implement', maxReworks },
    },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [
    { stepId: 'plan', handlerRef: 'plan.h' },
    { stepId: 'implement', handlerRef: 'impl.h' },
    { stepId: 'docs', handlerRef: 'docs.h' },
    { stepId: 'fast-check', handlerRef: 'tests' },
    { stepId: 'review', handlerRef: 'review.h' },
  ]);
  setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 14);
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 30);
  f.input.untrustedRoots = [f.taskDirectory, repository];
  await f.save();
  const loaded = assertOk(await f.load(), 'load 5-step pi rework fixture');
  return { ...f, repository, runRoot, loaded };
}

test('source.ts matchesScopePattern delegates to @loopwright/core with single-segment * and ? globs and validateProgress enforces same-epoch duplicate-ordinary refusal', async () => {
  assert.equal(matchesScopePattern('packages/*/src/*.ts', 'packages/controller/src/step.ts'), true);
  assert.equal(matchesScopePattern('packages/*/src/*.ts', 'packages/controller/src/sub/step.ts'), false);
  assert.equal(matchesScopePattern('docs/guide-?.md', 'docs/guide-1.md'), true);
  assert.equal(matchesScopePattern('docs/guide-?.md', 'docs/guide-12.md'), false);
  assert.equal(matchesScopePattern('.agents/**', '.agents/skills/my-skill/SKILL.md'), true);

  const f = await retainedFixture(1, 4, 1);
  try {
    const head = await f.progress.publish(f.draft, 'bootstrap');
    const cmd = await f.artifacts.put('unit-cmd', Buffer.from('cmd'));
    const sessionId = 'session.' + 'a'.repeat(40);
    const attempt1 = {
      ordinal: 1,
      id: stableId('run-1', 'build', 'task', 'none', 1),
      nodeId: 'build',
      nativeStepId: 'build',
      sessionId,
      purpose: 'task' as const,
      repair: 'none' as const,
      command: cmd,
      before: head.progress.stage.watermarks,
      finished: { after: head.progress.stage.watermarks, outcome: cmd, nativeCheckpointId: null },
    };
    const duplicateSameEpoch = {
      ordinal: 2,
      id: stableId('run-1', 'build', 'task', 'none', 2),
      nodeId: 'build',
      nativeStepId: 'build',
      sessionId,
      purpose: 'task' as const,
      repair: 'none' as const,
      command: cmd,
      before: head.progress.stage.watermarks,
      finished: null,
    };
    assert.throws(
      () =>
        validateProgress(
          {
            ...head.progress,
            sequence: 2,
            stage: {
              ...head.progress.stage,
              kind: 'role_pre',
              phase: 'role.2.pre',
              consumed: ['bootstrap', 'role.2.pre'],
            },
            attempts: [attempt1, duplicateSameEpoch],
          },
          f.plan,
          f.lock,
        ),
      /RECOVERY_REQUIRED/,
    );
  } finally {
    await f.close();
  }
});

test('controller.ts: full rework loop with unchanged candidateDigest, crash recovery via resumeCycleWithPorts, author Submission preservation, and maxReworks / human / fail terminal statuses', async () => {
  // 1. Complete 2-rework loop with unchanged candidateDigest in Epoch 1 + crash before Epoch 1 review!
  {
    const f = await setupFiveStepPiFixture(2);
    try {
      const executedSteps: string[] = [];
      const implementPrompts: string[] = [];
      const observedResources = new Map<string, readonly string[]>();
      let implCalls = 0;
      let reviewCalls = 0;

      const openAdapter = createPiMockPort(({ stepId, roleId, prompt, resourceIds }) => {
        executedSteps.push(stepId);
        observedResources.set(roleId, resourceIds);
        if (stepId === 'plan') {
          return { responseJson: { version: 1, status: 'completed', checks: [], reason: 'Planned.' } };
        }
        if (stepId === 'implement') {
          implCalls++;
          implementPrompts.push(prompt);
          return {
            ...(implCalls === 1 ? { files: { 'packages/result.json': JSON.stringify({ ok: true, v: 1 }) } } : {}),
            responseJson: {
              version: 1,
              status: 'completed',
              checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
              reason: 'Implemented.',
            },
          };
        }
        if (stepId === 'docs') {
          return {
            responseJson: {
              version: 1,
              status: 'completed',
              checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
              reason: 'Documented.',
            },
          };
        }
        reviewCalls++;
        if (reviewCalls === 1) {
          return {
            responseJson: {
              verdict: 'rework',
              summary: 'Please address finding F1.',
              findings: [{ title: 'Finding F1', severity: 'high', path: 'packages/result.json', line: 1, evidence: 'missing F1' }],
            } satisfies StepVerdict,
          };
        }
        if (reviewCalls === 2) {
          return {
            responseJson: {
              verdict: 'rework',
              summary: 'Please address finding F2 after unchanged digest.',
              findings: [{ title: 'Finding F2', severity: 'medium', path: 'docs/guide.md', line: 1, evidence: 'missing F2' }],
            } satisfies StepVerdict,
          };
        }
        return {
          responseJson: { verdict: 'pass', summary: 'Ship it.', findings: [] } satisfies StepVerdict,
        };
      });

      // Run via Cycle directly up to mid-Epoch-1 crash (before terminalization, simulating hard process kill!)
      const { createCycle, Cycle } = await import('../src/controller.js');
      const runId = 'run-pi-crash-rework';
      const ctx = await createCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId }, {
        openAdapter,
        afterCheckpoint: async (phase, head) => {
          if (head.progress.reworkEpoch === 1 && phase.startsWith('verify.') && phase.endsWith('.post')) {
            throw new Error('HARD_PROCESS_KILL');
          }
        },
      });
      const crashingCycle = new Cycle(ctx);
      await assert.rejects(crashingCycle.execute(), /HARD_PROCESS_KILL/);
      await crashingCycle.deadline.dispose();
      await crashingCycle.events.suspend();
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();

      // Now resume via public resumeCycleWithPorts!
      const resumed = assertOk(
        await resumeCycleWithPorts(
          { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId },
          { openAdapter },
        ),
        'resumeCycleWithPorts after mid-rework crash',
      );
      assert.equal(resumed.kind, 'result');
      if (resumed.kind === 'result') {
        assert.equal(resumed.result.spec.status, 'completed');
        // Verify observations preserved author requestedStatus === 'completed' and stepVerdicts!
        const obs = JSON.parse(await readFile(join(f.runRoot, runId, 'artifacts', resumed.observations!.name), 'utf8')) as Record<string, unknown>;
        assert.equal(obs.requestedStatus, 'completed');
        assert.equal(obs.requestedStatusSource, 'captured_submission');
        assert.ok(Array.isArray(obs.stepVerdicts));
        assert.equal((obs.stepVerdicts as unknown[]).length, 3);
      }

      // Verify `plan` ran ONLY ONCE while `implement -> docs -> review` ran 3 times!
      assert.deepEqual(executedSteps, [
        'plan',
        'implement',
        'docs',
        'review',
        'implement',
        'docs',
        'review',
        'implement',
        'docs',
        'review',
      ]);
      assert.equal(implementPrompts.length, 3);
      assert.equal(implementPrompts[0]?.includes('Finding F1'), false);
      assert.match(implementPrompts[1]!, /Finding F1/);
      assert.match(implementPrompts[1]!, /Please address finding F1/);
      assert.match(implementPrompts[2]!, /Finding F2/);

      // Verify per-role resourceIds isolation!
      assert.deepEqual(observedResources.get('planner'), ['plan-doc']);
      assert.deepEqual(observedResources.get('implementer'), ['impl-doc']);
      assert.deepEqual(observedResources.get('documenter'), []);
      assert.deepEqual(observedResources.get('reviewer'), []);
    } finally {
      await f.cleanup();
    }
  }

  // 2. Exceeding maxReworks halts deterministically as `blocked` preserving findings; `human` halts as `blocked`; `fail` halts as `failed`
  for (const scenario of ['exceed_max_reworks', 'human_verdict', 'fail_verdict'] as const) {
    const f = await setupFiveStepPiFixture(1);
    try {
      let reviewCalls = 0;
      const openAdapter = createPiMockPort(({ stepId }) => {
        if (stepId === 'implement') {
          return {
            files: { 'packages/result.json': JSON.stringify({ ok: true }) },
            responseJson: {
              version: 1,
              status: 'completed',
              checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
              reason: null,
            },
          };
        }
        if (stepId === 'plan' || stepId === 'docs') {
          return { responseJson: { version: 1, status: 'completed', checks: [], reason: 'ok' } };
        }
        reviewCalls++;
        if (scenario === 'exceed_max_reworks') {
          return {
            responseJson: {
              verdict: 'rework',
              summary: `Rework request #${reviewCalls}`,
              findings: [
                {
                  title: `Unresolved issue #${reviewCalls}`,
                  severity: 'critical',
                  path: 'packages/result.json',
                  line: 1,
                  evidence: 'still broken with SECRET_CANARY_XYZ',
                },
              ],
            } satisfies StepVerdict,
          };
        }
        if (scenario === 'human_verdict') {
          return {
            responseJson: {
              verdict: 'human',
              summary: 'Architectural sign-off needed.',
              findings: [{ title: 'Human review required', severity: 'high', evidence: 'API break' }],
            } satisfies StepVerdict,
          };
        }
        return {
          responseJson: {
            verdict: 'fail',
            summary: 'Hard security regression.',
            findings: [{ title: 'Security defect', severity: 'critical', evidence: 'unsafe eval' }],
          } satisfies StepVerdict,
        };
      });

      const execution = assertOk(
        await runCycleWithPorts(
          { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: `run-${scenario}` },
          { openAdapter },
        ),
        scenario,
      );
      assert.equal(execution.kind, 'result');
      if (execution.kind !== 'result') continue;

      if (scenario === 'exceed_max_reworks') {
        assert.equal(reviewCalls, 2); // initial + 1 rework, then halts on 2nd rework!
        assert.equal(execution.result.spec.status, 'blocked');
        assert.equal(execution.findings?.length, 2);
        assert.equal(execution.findings?.[1]?.title, 'Unresolved issue #2');

        const scrubber = new SecretScrubber();
        scrubber.register('SECRET_CANARY_XYZ');
        const jsonReport = JSON.parse(
          formatRunReport(
            {
              runId: `run-${scenario}`,
              status: execution.result.spec.status,
              findings: execution.findings,
              scrub: s => scrubber.scrub(s),
            },
            'json',
          ),
        ) as { findings: { title: string; evidence: string }[] };
        assert.equal(jsonReport.findings.length, 2);
        assert.equal(jsonReport.findings[0]!.evidence.includes('SECRET_CANARY_XYZ'), false);
        const mdReport = formatRunReport(
          {
            runId: `run-${scenario}`,
            status: execution.result.spec.status,
            findings: execution.findings,
            scrub: s => scrubber.scrub(s),
          },
          'markdown',
        );
        assert.match(mdReport, /### Findings/);
        assert.equal(mdReport.includes('SECRET_CANARY_XYZ'), false);
      } else if (scenario === 'human_verdict') {
        assert.equal(reviewCalls, 1); // halts immediately!
        assert.equal(execution.result.spec.status, 'blocked');
        assert.equal(execution.findings?.length, 1);
        assert.equal(execution.findings?.[0]?.title, 'Human review required');
      } else {
        assert.equal(reviewCalls, 1);
        assert.equal(execution.result.spec.status, 'failed');
        assert.equal(execution.findings?.length, 1);
        assert.equal(execution.findings?.[0]?.title, 'Security defect');
      }
    } finally {
      await f.cleanup();
    }
  }
});

test('step.ts parity: 5-step rework pipeline with unchanged candidateDigest and per-role resourceIds & allowedMcpServers', async () => {
  const f = await configurationFixture();
  let gateCalls = 0;
  const gateSecret = 'STEP_REWORK_GATE_SECRET_998877665544';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      gateCalls++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const verdict = {
        version: 1, kind: 'gate_verdict', storeId: parsed.storeId, runId: parsed.runId, lockHash: parsed.lockHash,
        operationId: parsed.operationId, dispatchId: parsed.dispatchId, dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId, checkId: parsed.checkId, candidateDigest: parsed.candidateDigest,
        status: 'approved', reason: null, expiresAtMs: String(Date.now() + 60_000),
      };
      const body = Buffer.from(canonical(verdict), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(gateSecret, body) });
      res.end(body);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const gateUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/gate`;

  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createGitRepo(repository, { 'packages/result.json': JSON.stringify({ ok: false }) });

    const resABytes = Buffer.from('Resource A only for implementer\n', 'utf8');
    const resBBytes = Buffer.from('Resource B only for planner\n', 'utf8');
    const resA = { id: 'res-a', kind: 'instruction' as const, path: 'res-a.md', digest: hash(resABytes) };
    const resB = { id: 'res-b', kind: 'instruction' as const, path: 'res-b.md', digest: hash(resBBytes) };
    await writeFile(join(f.operator, resA.path), resABytes, { mode: 0o600 });
    await writeFile(join(f.operator, resB.path), resBBytes, { mode: 0o600 });

    f.environment.GATE_SECRET = gateSecret;
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'resources'], [resA, resB]);
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-svc', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      { id: 'fast-gate', url: gateUrl, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1000, maxPollMs: 2000, pollInitialMs: 100, pollMaxMs: 200, jitter: 0 },
    ]);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'delegated-read', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'delegated-provider', model: 'review-model', thinking: 'low' }, tools: ['read'], mcp: null },
      { id: 'delegated-write', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'delegated-provider', model: 'author-model', thinking: 'high' }, tools: ['read', 'write', 'edit'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'plan.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Plan work.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'impl.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Implement work.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'docs.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Doc work.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'fast.gate', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'fast-check', endpointRef: 'fast-gate', gateId: 'fast-gate-id' }, capabilities: ['external_service', 'read_only'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review work.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'credentials'], [{ ref: 'gate-signer', template: '${GATE_SECRET}' }]);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 12);
    setFixture(f.config, ['spec', 'controls', 'submission', 'path'], 'packages/sub.json');
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [resA, resB]);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['fast-check'],
      checks: [{ id: 'fast-check', allowedEvidenceLevels: ['external_service'] }],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'planner', adapter: 'delegated', provider: 'delegated-provider', model: 'review-model', thinking: 'low', tools: ['read'], resourceIds: ['res-b'] },
      { id: 'implementer', adapter: 'delegated', provider: 'delegated-provider', model: 'author-model', thinking: 'high', tools: ['read', 'write', 'edit'], resourceIds: ['res-a'] },
      { id: 'documenter', adapter: 'delegated', provider: 'delegated-provider', model: 'author-model', thinking: 'high', tools: ['read', 'write'], resourceIds: [] },
      { id: 'reviewer', adapter: 'delegated', provider: 'delegated-provider', model: 'review-model', thinking: 'low', tools: ['read'], resourceIds: [] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'planner', profileRef: 'delegated-read' },
      { roleId: 'implementer', profileRef: 'delegated-write' },
      { roleId: 'documenter', profileRef: 'delegated-write' },
      { roleId: 'reviewer', profileRef: 'delegated-read' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'plan', kind: 'agent', uses: 'plan.h', roleId: 'planner', dependsOn: [] },
      { id: 'implement', kind: 'agent', uses: 'impl.h', roleId: 'implementer', dependsOn: ['plan'] },
      { id: 'docs', kind: 'agent', uses: 'docs.h', roleId: 'documenter', dependsOn: ['implement'] },
      { id: 'fast-check', kind: 'check', uses: 'fast.gate', roleId: null, dependsOn: ['docs'] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['fast-check'], onRework: { rejectTo: 'implement', maxReworks: 2 } },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'plan', handlerRef: 'plan.h' },
      { stepId: 'implement', handlerRef: 'impl.h' },
      { stepId: 'docs', handlerRef: 'docs.h' },
      { stepId: 'fast-check', handlerRef: 'fast.gate' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load step rework fixture');
    const envFn = (k: string) => f.environment[k];

    const runId = 'run-step-rework-reconcile';
    // 1. `plan` yields with res-b only and empty allowedMcpServers
    const planYield = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loaded,
          repository,
          runRoot,
          runId,
          environment: envFn,
          roleMcpServers: { implementer: ['srv-a'], reviewer: [] },
          mcpServers: [{ id: 'srv-a', transport: 'stdio', toolNames: ['mcp__srv-a__ping'] }],
        }),
        'stepNext plan',
      ),
    );
    assert.equal(planYield.stepId, 'plan');
    assert.equal(planYield.contextFiles.length, 1);
    assert.ok(planYield.contextFiles[0]!.endsWith('res-b.md'));
    assert.deepEqual(planYield.allowedMcpServers, []);
    assert.deepEqual(planYield.mcpServers, []);

    // 2. Submit `plan` -> yields `implement` with res-a and srv-a!
    const impl0 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: planYield.leaseToken, environment: envFn }), 'submit plan'),
    );
    assert.equal(impl0.stepId, 'implement');
    assert.equal(impl0.reworkEpoch, 0);
    assert.equal(impl0.rework, null);
    assert.equal(impl0.contextFiles.length, 1);
    assert.ok(impl0.contextFiles[0]!.endsWith('res-a.md'));
    assert.deepEqual(impl0.allowedMcpServers, ['srv-a']);
    assert.equal(impl0.mcpServers.length, 1);
    assert.equal(impl0.mcpServers[0]?.id, 'srv-a');

    await writeFile(join(impl0.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    await writeFile(
      join(impl0.candidateDir, 'packages', 'sub.json'),
      JSON.stringify({
        version: 1,
        status: 'completed',
        checks: [{ checkId: 'fast-check', status: 'passed', evidenceId: null, reason: null }],
        reason: null,
      }),
      { mode: 0o600 },
    );

    // 3. Submit `implement` -> yields `docs` with 0 contextFiles
    const docs0 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: impl0.leaseToken, environment: envFn }), 'submit impl0'),
    );
    assert.equal(docs0.stepId, 'docs');
    assert.deepEqual(docs0.contextFiles, []);

    // 4. Submit `docs` -> runs `fast-check` gate (#1) -> yields `review` (with [] allowedMcpServers!)
    const rev0 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: docs0.leaseToken, environment: envFn }), 'submit docs0'),
    );
    assert.equal(rev0.stepId, 'review');
    assert.equal(gateCalls, 1);
    assert.deepEqual(rev0.allowedMcpServers, []);
    assert.deepEqual(rev0.mcpServers, []);

    // 5. Submit `review` with StepVerdict `rework` via submissionFile -> resets ONLY [implement, docs, fast-check, review] (NOT plan!)
    const verdictFile = join(f.root, 'review-verdict-1.json');
    await writeFile(
      verdictFile,
      JSON.stringify({
        verdict: 'rework',
        summary: 'Verify idempotency even when digest is unchanged.',
        findings: [{ title: 'Re-verify unchanged', severity: 'medium', path: 'packages/result.json', line: 1, evidence: 'check gate again' }],
      } satisfies StepVerdict),
      { mode: 0o600 },
    );
    const impl1 = assertStepYield(
      assertOk(
        await stepSubmit({ runRoot, runId, leaseToken: rev0.leaseToken, submissionFile: verdictFile, environment: envFn }),
        'submit review0 rework',
      ),
    );
    assert.equal(impl1.stepId, 'implement'); // plan was NOT re-run!
    assert.equal(impl1.reworkEpoch, 1);
    assert.equal(impl1.rework?.count, 1);
    assert.equal(impl1.rework?.maxReworks, 2);
    assert.equal(impl1.rework?.findings[0]?.title, 'Re-verify unchanged');
    assert.match(impl1.prompt, /Re-verify unchanged/);

    // 6. Leave candidateDir UNCHANGED in Epoch 1 -> submit `implement` -> yields `docs`
    const docs1 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: impl1.leaseToken, environment: envFn }), 'submit impl1 unchanged'),
    );
    assert.equal(docs1.stepId, 'docs');

    // 7. Gate re-runs in Epoch 1 despite unchanged candidateDigest
    const rev1 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: docs1.leaseToken, environment: envFn }), 'submit docs1'),
    );
    assert.equal(rev1.stepId, 'review');
    assert.equal(gateCalls, 2); // Gate RE-RAN in Epoch 1 despite UNCHANGED candidateDigest!

    // Submit `review` with StepVerdict `pass` -> settles `completed` WITHOUT overwriting author's packages/sub.json Submission!
    const passFile = join(f.root, 'review-verdict-pass.json');
    await writeFile(passFile, JSON.stringify({ verdict: 'pass', summary: 'Approved!', findings: [] } satisfies StepVerdict), { mode: 0o600 });
    const settled = assertOk(
      await stepSubmit({ runRoot, runId, leaseToken: rev1.leaseToken, submissionFile: passFile, environment: envFn }),
      'submit review1 pass',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'completed');
      const obs = JSON.parse(await readFile(join(runRoot, runId, 'artifacts', settled.observations!.name), 'utf8')) as Record<string, unknown>;
      assert.equal(obs.requestedStatus, 'completed');
      assert.equal(obs.requestedStatusSource, 'captured_submission');
    }
    void phaseCheckpointId;
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await f.cleanup();
  }
});

test('step.ts parity: mid-POST gate crash in rework Epoch 1 reconciles cleanly via reconcileCycle() and resumes to completion', async () => {
  const f = await configurationFixture();
  const gateSecret = 'RECONCILE_EPOCH1_SECRET_1234567890';
  let respondPending = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const verdict = {
        version: 1,
        kind: 'gate_verdict',
        storeId: parsed.storeId,
        runId: parsed.runId,
        lockHash: parsed.lockHash,
        operationId: parsed.operationId,
        dispatchId: parsed.dispatchId,
        dispatchGeneration: parsed.dispatchGeneration,
        gateId: parsed.gateId,
        checkId: parsed.checkId,
        candidateDigest: parsed.candidateDigest,
        status: respondPending ? 'pending' : 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 60_000),
      };
      const body = Buffer.from(canonical(verdict), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json', 'x-loopwright-signature': signPayload(gateSecret, body) });
      res.end(body);
    })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const gateUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/gate`;

  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createGitRepo(repository, { 'packages/result.json': JSON.stringify({ ok: true }) });

    f.environment.GATE_SECRET = gateSecret;
    const prevGateEnv = process.env.GATE_SECRET;
    process.env.GATE_SECRET = gateSecret;
    try {
      const installed = await installedHandlerDigests();
      setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
      setFixture(f.registry, ['spec', 'credentialBindings'], [
        { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-svc', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
      ]);
      setFixture(f.registry, ['spec', 'environmentBindings'], [
        { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template'] },
      ]);
      setFixture(f.registry, ['spec', 'gateEndpoints'], [
        { id: 'fast-gate', url: gateUrl, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1000, maxPollMs: 2000, pollInitialMs: 100, pollMaxMs: 200, jitter: 0 },
      ]);
      setFixture(f.registry, ['spec', 'roleProfiles'], [
        { id: 'del-write', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'delegated-provider', model: 'author-model', thinking: 'high' }, tools: ['read', 'write'], mcp: null },
        { id: 'del-read', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'delegated-provider', model: 'review-model', thinking: 'low' }, tools: ['read'], mcp: null },
      ]);
      setFixture(f.registry, ['spec', 'handlers'], [
        { id: 'impl.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Implement.', purpose: 'task' }, capabilities: ['pi'] },
        { id: 'fast.gate', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'fast-check', endpointRef: 'fast-gate', gateId: 'fg' }, capabilities: ['external_service', 'read_only'] },
        { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
        ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
      ]);
      setFixture(f.config, ['spec', 'credentials'], [{ ref: 'gate-signer', template: '${GATE_SECRET}' }]);
      setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 8);
      setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
      setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
      setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
      setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
        required: ['fast-check'],
        checks: [{ id: 'fast-check', allowedEvidenceLevels: ['external_service'] }],
      });
      setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
        { id: 'impl', adapter: 'delegated', provider: 'delegated-provider', model: 'author-model', thinking: 'high', tools: ['read', 'write'] },
        { id: 'rev', adapter: 'delegated', provider: 'delegated-provider', model: 'review-model', thinking: 'low', tools: ['read'] },
      ]);
      setFixture(f.config, ['spec', 'profiles', 'roles'], [
        { roleId: 'impl', profileRef: 'del-write' },
        { roleId: 'rev', profileRef: 'del-read' },
      ]);
      setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
        { id: 'implement', kind: 'agent', uses: 'impl.h', roleId: 'impl', dependsOn: [] },
        { id: 'fast-check', kind: 'check', uses: 'fast.gate', roleId: null, dependsOn: ['implement'] },
        { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'rev', dependsOn: ['fast-check'], onRework: { rejectTo: 'implement', maxReworks: 2 } },
      ]);
      setFixture(f.config, ['spec', 'profiles', 'steps'], [
        { stepId: 'implement', handlerRef: 'impl.h' },
        { stepId: 'fast-check', handlerRef: 'fast.gate' },
        { stepId: 'review', handlerRef: 'review.h' },
      ]);
      f.input.untrustedRoots = [f.taskDirectory, repository];
      await f.save();
      const loaded = assertOk(await f.load(), 'load reconcile fixture');
      const reworkVerdict: StepVerdict = {
        verdict: 'rework',
        summary: 'Re-run in epoch 1.',
        findings: [{ title: 'Check again', severity: 'low', evidence: 're-verify' }],
      };

      const { reopenLocalRun } = await import('@loopwright/state');
      const { Gate, prepareGate } = await import('../src/gate.js');
      const { ProgressStore } = await import('../src/progress.js');
      const { ControllerOwner } = await import('../src/ownership.js');
      const { ArtifactStore } = await import('../src/storage.js');
      const { approvedState } = await import('../src/config.js');

      const runId2 = 'run-reconcile-genuine';
      const a1 = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runId2 })));
      const a2 = assertStepYield(assertOk(await stepSubmit({ runRoot, runId: runId2, leaseToken: a1.leaseToken })));
      const a3 = assertStepYield(assertOk(await stepSubmit({ runRoot, runId: runId2, leaseToken: a2.leaseToken, verdict: reworkVerdict })));
      await stepSubmit(
        { runRoot, runId: runId2, leaseToken: a3.leaseToken },
        {
          // Throwing on role.3.post leaves head cleanly at role.3.post (reworkEpoch === 1, generation === 1, UNCHANGED candidateDigest)
          afterCheckpoint: async phase => {
            if (phase === 'role.3.post') throw new Error('CRASH_AFTER_ROLE_3_POST');
          },
        },
      );

      // Run real Gate.run in Epoch 1 (`generation = 1`) and simulate process death mid-poll (`onWait` throws) so operation stays `dispatch_uncertain`!
      const runDir = join(runRoot, runId2);
      const desc = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
      const planJson = JSON.parse(await readFile(join(runDir, 'artifacts', desc.plan.name), 'utf8'));
      const owner2 = await ControllerOwner.acquire(runDir, runId2, planJson.planDigest);
      const store = stateValue(reopenLocalRun(desc.identity));
      const view0 = stateValue(store.inspect());
      const auth = stateValue(store.claim({ ownerId: 'controller.' + owner2.nonce, expectedGeneration: view0.owner.generation, expectedRevision: view0.revision, mode: 'active' })).authority;
      const artifacts = new ArtifactStore(join(runDir, 'artifacts'), owner2, approvedState(loaded).vault);
      const prog = new ProgressStore(store, auth, artifacts, planJson, desc.identity.lock, desc.plan, desc.source);
      const head3 = (await prog.read())!;
      assert.equal(head3.progress.reworkEpoch, 1);
      assert.equal(head3.progress.candidate.generation, 1);

      const nonce = 'abcd'.repeat(8);
      const candInv = { manifest: head3.manifest, ref: head3.progress.candidate.manifest, files: [] };
      const job = prepareGate(planJson, desc.identity.lock, 'check.fast-check', candInv, 1, nonce, loaded.registry.spec.gateEndpoints);
      const headVerifyPre = await prog.publish(
        {
          ...head3.progress,
          stage: { ...head3.progress.stage, kind: 'verifier_pre' },
          verifierReceipts: [...head3.progress.verifierReceipts, { slot: 'check.fast-check', generation: 1, reworkEpoch: 1, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null }],
        },
        'verify.1.0.pre',
      );
      respondPending = true;
      const gateClient = new Gate(
        store,
        auth,
        artifacts,
        planJson,
        desc.identity.lock,
        ref => approvedState(loaded).vault.resolveNetworkCredential(ref),
        () => headVerifyPre.checkpoint.subject,
        async () => {
          throw new Error('CRASH_MID_GATE_POLL');
        },
      );
      await assert.rejects(gateClient.run(job, new AbortController().signal), /CRASH_MID_GATE_POLL/);
      respondPending = false;

      const opState = stateValue(store.getOperation(job.operationId));
      assert.equal(opState.state, 'dispatch_uncertain');
      const storeId = stateValue(store.inspect()).storeId;
      const candDigestHex = headVerifyPre.checkpoint.subject.candidateDigest.hex;
      stateValue(store.release(auth));
      stateValue(store.close());
      await owner2.release();

      // Write signed operator gate_verdict receipt for Epoch 1 (`generation = 1`) and call `reconcileCycle`!
      const receiptPath = join(f.root, 'epoch1-gate-receipt.json');
      const receiptBody = {
        version: 1,
        kind: 'gate_verdict',
        storeId,
        runId: runId2,
        lockHash: desc.identity.lock.spec.lockHash,
        operationId: job.operationId,
        dispatchId: opState.dispatch!.dispatchId,
        dispatchGeneration: opState.dispatch!.generation,
        gateId: 'fg',
        checkId: 'fast-check',
        candidateDigest: candDigestHex,
        status: 'approved',
        reason: null,
        expiresAtMs: String(Date.now() + 60_000),
      };
      const signedReceipt = { ...receiptBody, signature: signPayload(gateSecret, canonical(receiptBody)) };
      await writeFile(receiptPath, canonical(signedReceipt), { mode: 0o600 });

      const reconciled = assertOk(await reconcileCycle({ configuration: loaded, runRoot, runId: runId2, receipt: receiptPath }), 'reconcileCycle epoch 1');
      assert.equal(reconciled.kind, 'unresolved');
      if (reconciled.kind === 'unresolved') assert.equal(reconciled.reason, 'delegated_step_required');

      // Now `stepNext` resumes cleanly from the reconciled gate and yields `review` in Epoch 1!
      const a4 = assertStepYield(assertOk(await stepNext({ runRoot, runId: runId2 }), 'stepNext after reconcileCycle'));
      assert.equal(a4.stepId, 'review');
      assert.equal(a4.reworkEpoch, 1);

      // Submit `review` pass -> run settles `completed`!
      const done = assertOk(
        await stepSubmit({ runRoot, runId: runId2, leaseToken: a4.leaseToken, verdict: { verdict: 'pass', summary: 'Done!', findings: [] } }),
        'final review pass after reconcileCycle',
      );
      assert.equal(done.kind, 'result');
      if (done.kind === 'result') assert.equal(done.result.spec.status, 'completed');
    } finally {
      if (prevGateEnv === undefined) delete process.env.GATE_SECRET;
      else process.env.GATE_SECRET = prevGateEnv;
    }
  } finally {
    await new Promise<void>(resolve => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await f.cleanup();
  }
});

test('step.ts parity: .agents/** opt-in writable, .claude/** protected, .github/workflows/** host-gated allowWorkflowWrites, and 512-file budgets.overlay scanning', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(join(repository, '.agents', 'skills'), { recursive: true, mode: 0o700 });
    await mkdir(join(repository, '.claude'), { recursive: true, mode: 0o700 });
    await mkdir(join(repository, '.github', 'workflows'), { recursive: true, mode: 0o700 });
    await mkdir(join(repository, 'packages'), { recursive: true, mode: 0o700 });
    await writeFile(join(repository, '.agents', 'skills', 's.md'), '# Skill v1\n', { mode: 0o600 });
    await writeFile(join(repository, '.claude', 'settings.json'), '{}\n', { mode: 0o600 });
    await writeFile(join(repository, '.github', 'workflows', 'ci.yml'), 'name: CI\n', { mode: 0o600 });
    await writeFile(join(repository, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    // Add > 128 baseline files so FrozenSource uses tree_overlay (version: 2)
    for (let i = 0; i < 135; i++) {
      await writeFile(join(repository, 'packages', `base-${i}.txt`), `base-${i}\n`, { mode: 0o600 });
    }

    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
      });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Step Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'baseline']);
    const rev = git(['rev-parse', 'HEAD']).trim();

    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'edit'], mcp: null },
      { id: 'reviewer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' }, tools: ['read'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 2, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
      writable: ['packages/**', '.agents/**', '.github/workflows/**'],
      protected: ['.claude/**'],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 512, maxBytes: 16_777_216 });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'edit'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'author', profileRef: 'author' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load overlay + scope fixture');

    // A. Default allowWorkflowWrites === false:
    // - .agents/skills/s.md IS writable (0o600)
    // - .claude/settings.json IS protected (0o400)
    // - .github/workflows/ci.yml IS protected (0o400) even though scope.writable includes .github/workflows/**!
    const runDefault = 'run-scope-default';
    const yDefault = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runDefault })));
    assert.equal(yDefault.allowWorkflowWrites, false);
    assert.equal((await lstat(join(yDefault.candidateDir, '.agents', 'skills', 's.md'))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(yDefault.candidateDir, '.claude', 'settings.json'))).mode & 0o777, 0o400);
    assert.equal((await lstat(join(yDefault.candidateDir, '.github', 'workflows', 'ci.yml'))).mode & 0o777, 0o400);

    // Force-editing .github/workflows/ci.yml when allowWorkflowWrites is false refuses ARTIFACT_INVALID!
    await chmod(join(yDefault.candidateDir, '.github', 'workflows', 'ci.yml'), 0o600);
    await writeFile(join(yDefault.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: Tampered\n', { mode: 0o600 });
    const deniedWf = await stepSubmit({ runRoot, runId: runDefault, leaseToken: yDefault.leaseToken });
    assert.equal(deniedWf.ok, false);
    if (!deniedWf.ok) assert.equal(deniedWf.error.code, 'ARTIFACT_INVALID');

    // Restore ci.yml, edit .agents/skills/s.md + write 511 more overlay files (= 512 overlay files total!) -> succeeds!
    await writeFile(join(yDefault.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n', { mode: 0o400 });
    await writeFile(join(yDefault.candidateDir, '.agents', 'skills', 's.md'), '# Skill v2\n', { mode: 0o600 });
    for (let i = 0; i < 511; i++) {
      await writeFile(join(yDefault.candidateDir, 'packages', `gen-${String(i).padStart(3, '0')}.txt`), `overlay-${i}\n`, { mode: 0o600 });
    }
    const revYield = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId: runDefault, leaseToken: yDefault.leaseToken }), '512-file overlay stepSubmit'),
    );
    assert.equal(revYield.stepId, 'review');
    assert.equal(await readFile(join(revYield.candidateDir, '.agents', 'skills', 's.md'), 'utf8'), '# Skill v2\n');
    assert.equal(await readFile(join(revYield.candidateDir, 'packages', 'gen-510.txt'), 'utf8'), 'overlay-510\n');

    const inspected = assertOk(await inspectRun({ runRoot, runId: runDefault }), 'inspectRun 512-file overlay');
    assert.equal(inspected.status.source, 'current');

    // B. Host-gated allowWorkflowWrites === true unlocks .github/workflows/ci.yml (while keeping .claude/** protected!)
    const runUnlocked = 'run-scope-unlocked';
    const yUnlocked = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runUnlocked, allowWorkflowWrites: true })),
    );
    assert.equal(yUnlocked.allowWorkflowWrites, true);
    assert.equal((await lstat(join(yUnlocked.candidateDir, '.github', 'workflows', 'ci.yml'))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(yUnlocked.candidateDir, '.claude', 'settings.json'))).mode & 0o777, 0o400);
    await writeFile(join(yUnlocked.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: CI v2\n', { mode: 0o600 });
    const revUnlocked = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId: runUnlocked, leaseToken: yUnlocked.leaseToken }), 'submit unlocked workflow edit'),
    );
    assert.equal(await readFile(join(revUnlocked.candidateDir, '.github', 'workflows', 'ci.yml'), 'utf8'), 'name: CI v2\n');
  } finally {
    await f.cleanup();
  }
});

async function createGitRepo(directory: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(directory, rel);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    await writeFile(abs, body, { mode: 0o600 });
  }
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
    });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Review T4 Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
  return git(['rev-parse', 'HEAD']).trim();
}

async function setupDelegatedAuthorReviewFixture(options: {
  readonly initialOk: boolean;
  readonly maxAttempts: number;
  readonly maxFormatRepairs?: number;
  readonly onRework?: { readonly rejectTo: string; readonly maxReworks: number };
}) {
  const f = await configurationFixture();
  const repository = join(f.root, 'repository');
  const runRoot = join(f.root, 'runs');
  const rev = await createGitRepo(repository, { 'packages/result.json': JSON.stringify({ ok: options.initialOk }) });
  const installed = await installedHandlerDigests();
  setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
  setFixture(f.registry, ['spec', 'credentialBindings'], []);
  setFixture(f.registry, ['spec', 'environmentBindings'], []);
  setFixture(f.registry, ['spec', 'roleProfiles'], [
    { id: 'del-author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'delegated-provider', model: 'author-model', thinking: 'high' }, tools: ['read', 'write'], mcp: null },
    { id: 'del-review', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'delegated-provider', model: 'review-model', thinking: 'low' }, tools: ['read'], mcp: null },
  ]);
  setFixture(f.registry, ['spec', 'handlers'], [
    { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Implement.', purpose: 'task' }, capabilities: ['pi'] },
    { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
    { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
    ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
  ]);
  setFixture(f.config, ['spec', 'credentials'], []);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
  setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
  setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
    { id: 'author', adapter: 'delegated', provider: 'delegated-provider', model: 'author-model', thinking: 'high', tools: ['read', 'write'] },
    { id: 'reviewer', adapter: 'delegated', provider: 'delegated-provider', model: 'review-model', thinking: 'low', tools: ['read'] },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'roles'], [
    { roleId: 'author', profileRef: 'del-author' },
    { roleId: 'reviewer', profileRef: 'del-review' },
  ]);
  setFixture(f.config, ['spec', 'controls', 'maxAttempts'], options.maxAttempts);
  if (options.maxFormatRepairs !== undefined) {
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxFormatRepairs'], options.maxFormatRepairs);
  }
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 0);
  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
    { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
    { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'], ...(options.onRework ? { onRework: options.onRework } : {}) },
    { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['review'] },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [
    { stepId: 'author', handlerRef: 'author.h' },
    { stepId: 'review', handlerRef: 'review.h' },
    { stepId: 'verify', handlerRef: 'tests' },
  ]);
  f.input.untrustedRoots = [f.taskDirectory, repository];
  await f.save();
  const loaded = assertOk(await f.load(), 'load delegated author-review fixture');
  return { f, repository, runRoot, loaded };
}

test('stepSubmit strips undefined optional finding fields, compacts StoredStepVerdict, and bounds observations for inspectRun while returning all >256 findings', async () => {
  const { f, repository, runRoot, loaded } = await setupDelegatedAuthorReviewFixture({
    initialOk: false,
    maxAttempts: 10,
    onRework: { rejectTo: 'author', maxReworks: 4 },
  });
  try {

    const makeLargeFindings = (epoch: number, count: number): StepVerdict['findings'] =>
      Array.from({ length: count }, (_, i) => ({
        title: `Epoch ${epoch} finding ${i}`,
        severity: 'medium' as const,
        // Explicitly test undefined optional fields on the very first finding (Fix #1)!
        ...(i === 0 ? { path: undefined, line: undefined } : { path: 'packages/result.json', line: i + 1 }),
        evidence: `Detailed evidence block e${epoch}-f${i}: ` + 'x'.repeat(1400),
      })) as unknown as StepVerdict['findings'];

    // 5 epochs x 64 large findings (LIMITS.findings = 64) = 320 total findings (~480 KiB raw across verdicts, >90 KiB each, >256 total!)
    const runId = 'run-large-verdicts';
    let aYield = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId })));
    for (let ep = 0; ep < 4; ep++) {
      await writeFile(join(aYield.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: false, pass: ep }), { mode: 0o600 });
      const rYield = assertStepYield(assertOk(await stepSubmit({ runRoot, runId, leaseToken: aYield.leaseToken })));
      aYield = assertStepYield(
        assertOk(
          await stepSubmit({
            runRoot,
            runId,
            leaseToken: rYield.leaseToken,
            verdict: { verdict: 'rework', summary: `Epoch ${ep} needs fixes`, findings: makeLargeFindings(ep, 64) },
          }),
          `epoch ${ep} large verdict`,
        ),
      );
      assert.equal(aYield.reworkEpoch, ep + 1);
      assert.equal(aYield.rework?.findings.length, 64);
    }
    await writeFile(join(aYield.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true, pass: 4 }), { mode: 0o600 });
    const finalReview = assertStepYield(assertOk(await stepSubmit({ runRoot, runId, leaseToken: aYield.leaseToken })));

    // Epoch 4 pass (64 findings -> 320 total findings > 256 inspectRun collection limit!)
    const settled = assertOk(
      await stepSubmit({
        runRoot,
        runId,
        leaseToken: finalReview.leaseToken,
        verdict: { verdict: 'pass', summary: 'All fixed with advisory notes', findings: makeLargeFindings(4, 64) },
      }),
      'epoch 4 large pass verdict',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'completed');
      assert.equal(settled.stepVerdicts?.length, 5);
      assert.equal(settled.findings?.length, 320);
      assert.equal('path' in settled.findings![0]!, false);
      assert.equal('line' in settled.findings![0]!, false);
      assert.ok(settled.observations);
      const obsRaw = JSON.parse(await readFile(join(runRoot, runId, 'artifacts', settled.observations.name), 'utf8')) as Record<string, unknown>;
      assert.equal(obsRaw.findingsTruncated, true);
      assert.equal(obsRaw.totalFindingsCount, 320);
      assert.ok(Array.isArray(obsRaw.findings) && obsRaw.findings.length <= 256);
    }

    // inspectRun() must succeed cleanly with status.source === 'current' (no 256-collection overflow)!
    const inspected = assertOk(await inspectRun({ runRoot, runId }), 'inspectRun >256 findings');
    assert.equal(inspected.status.source, 'current');
  } finally {
    await f.cleanup();
  }
});

test('strict StepVerdict vs Submission step binding refuses cross-schema outputs, resets stale failedRaw after verdict repair, and synthesizes StepVerdict on review stepSubmit({})', async () => {
  const { f, repository, runRoot, loaded } = await setupDelegatedAuthorReviewFixture({
    initialOk: false,
    maxAttempts: 6,
    maxFormatRepairs: 2,
  });
  try {

    // A. Non-verdict task step emitting StepVerdict JSON refuses SUBMISSION_INVALID (triggers format repair for submission.v1!)
    //    AND review step emitting submission.v1 refuses SUBMISSION_INVALID (triggers verdictFormatPrompt!)
    const runA = 'run-schema-strict';
    const yAuthor = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runA })));
    await writeFile(join(yAuthor.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const yAuthorRepair = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot,
          runId: runA,
          leaseToken: yAuthor.leaseToken,
          verdict: { verdict: 'fail', summary: 'spoofed verdict from task step', findings: [] },
        }),
        'task step verdict refused into format repair',
      ),
    );
    assert.equal(yAuthorRepair.stepId, 'author');
    assert.equal(yAuthorRepair.repair, 'format');

    // Author repairs with valid submission.v1 -> yields review
    const yReview = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId: runA, leaseToken: yAuthorRepair.leaseToken }), 'author format repair'),
    );
    assert.equal(yReview.stepId, 'review');

    // Review submits a submission.v1 file -> MUST refuse SUBMISSION_INVALID and trigger verdictFormatPrompt!
    const subFile = join(f.root, 'wrong-sub.json');
    await writeFile(
      subFile,
      JSON.stringify({ version: 1, status: 'completed', checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }], reason: null }),
      { mode: 0o600 },
    );
    const yReviewRepair = assertStepYield(
      assertOk(
        await stepSubmit({ runRoot, runId: runA, leaseToken: yReview.leaseToken, submissionFile: subFile }),
        'review submission.v1 refused into verdict format repair',
      ),
    );
    assert.equal(yReviewRepair.stepId, 'review');
    assert.equal(yReviewRepair.repair, 'format');
    assert.match(yReviewRepair.prompt, /verdict/i);

    // Review repairs with default stepSubmit({}) -> synthesizes StepVerdict('pass') and settles completed with zero contradictions!
    const settledA = assertOk(
      await stepSubmit({ runRoot, runId: runA, leaseToken: yReviewRepair.leaseToken }),
      'review format repair synthesized StepVerdict',
    );
    assert.equal(settledA.kind, 'result');
    if (settledA.kind === 'result') {
      assert.equal(settledA.result.spec.status, 'completed');
      assert.equal(settledA.stepVerdicts?.length, 1);
      assert.equal(settledA.stepVerdicts?.[0]?.verdict.verdict, 'pass');
      assert.ok(settledA.observations);
      const obsA = JSON.parse(await readFile(join(runRoot, runA, 'artifacts', settledA.observations.name), 'utf8')) as Record<string, unknown>;
      assert.deepEqual(obsA.contradictions, []);
    }

    // B. Review-first run where review fails format (so submission was null & failedRaw was written) then repairs with StepVerdict -> stale failedRaw is cleared!
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: [] },
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: ['review'] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'review', handlerRef: 'review.h' },
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    await f.save();
    const revFirstLoaded = assertOk(await f.load(), 'load review-first fixture');
    const runB = 'run-verdict-stale-raw';
    const yRevFirst = assertStepYield(assertOk(await stepNext({ configuration: revFirstLoaded, repository, runRoot, runId: runB })));
    const yRevFirstRepair = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId: runB, leaseToken: yRevFirst.leaseToken, submissionFile: subFile })),
    );
    assert.equal(yRevFirstRepair.repair, 'format');
    const yAuthAfter = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot,
          runId: runB,
          leaseToken: yRevFirstRepair.leaseToken,
          verdict: { verdict: 'pass', summary: 'review ok', findings: [] },
        }),
      ),
    );
    assert.equal(yAuthAfter.stepId, 'author');
    await writeFile(join(yAuthAfter.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const settledB = assertOk(await stepSubmit({ runRoot, runId: runB, leaseToken: yAuthAfter.leaseToken }));
    assert.equal(settledB.kind, 'result');
    if (settledB.kind === 'result') {
      assert.equal(settledB.result.spec.status, 'completed');
    }
  } finally {
    await f.cleanup();
  }
});

test('retainedPrimary and post-terminal.intent crash recovery preserve findings & stepVerdicts, and resumeCycleWithPorts refuses delegated format repair with upstream submission', async () => {
  const { f, repository, runRoot, loaded } = await setupDelegatedAuthorReviewFixture({
    initialOk: true,
    maxAttempts: 6,
    maxFormatRepairs: 2,
  });
  try {

    // A. Crash right after terminal.intent (preserving controller-events.open as SIGKILL does), then reopen via resumeCycleWithPorts & post-terminal stepNext -> findings, stepVerdicts, and recovered observations preserved!
    const runCrash = 'run-crash-terminal-intent';
    const yA = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runCrash })));
    const yR = assertStepYield(assertOk(await stepSubmit({ runRoot, runId: runCrash, leaseToken: yA.leaseToken })));
    let savedOpenEvents: Buffer | null = null;
    const openEventsPath = join(runRoot, runCrash, 'artifacts', 'controller-events.open');
    const crashed = assertOk(
      await stepSubmit(
        {
          runRoot,
          runId: runCrash,
          leaseToken: yR.leaseToken,
          verdict: {
            verdict: 'pass',
            summary: 'Passed with 1 note',
            findings: [{ title: 'Retained note', severity: 'low', path: 'packages/result.json', line: 1, evidence: 'survived crash' }],
          },
        },
        {
          afterCheckpoint: async phase => {
            if (phase === 'terminal.intent') {
              savedOpenEvents = await readFile(openEventsPath);
              throw new Error('simulated crash after terminal.intent');
            }
          },
        },
      ),
    );
    // Throwing inside afterCheckpoint('terminal.intent') aborts before `admitted = true` while terminal.intent IS committed on disk
    assert.equal(crashed.kind, 'incident');
    assert.ok(savedOpenEvents !== null);
    // Restore controller-events.open as it would remain after an OS crash (in-process finally closed/unlinked it)
    await writeFile(openEventsPath, savedOpenEvents, { mode: 0o600 });

    const recovered = assertOk(
      await resumeCycleWithPorts({ configuration: loaded, repository, runRoot, runId: runCrash }),
      'resumeCycleWithPorts after terminal.intent crash',
    );
    assert.equal(recovered.kind, 'result');
    if (recovered.kind === 'result') {
      assert.equal(recovered.result.spec.status, 'completed');
      assert.equal(recovered.findings?.length, 1);
      assert.equal(recovered.findings?.[0]?.title, 'Retained note');
      assert.equal(recovered.stepVerdicts?.length, 1);
      assert.ok(recovered.observations);
      const obsRec = JSON.parse(await readFile(join(runRoot, runCrash, 'artifacts', recovered.observations.name), 'utf8')) as Record<string, unknown>;
      assert.equal(obsRec.recoveredOriginalPrimary, true);
      assert.equal((obsRec.findings as readonly unknown[])?.length, 1);
      assert.equal((obsRec.stepVerdicts as readonly unknown[])?.length, 1);
    }

    const postTerminalStep = assertOk(await stepNext({ runRoot, runId: runCrash }), 'post-terminal stepNext');
    assert.equal(postTerminalStep.kind, 'result');
    if (postTerminalStep.kind === 'result') {
      assert.equal(postTerminalStep.findings?.length, 1);
      assert.equal(postTerminalStep.stepVerdicts?.length, 1);
    }

    // B. Upstream author submits valid submission.v1 (submission !== null), then review fails format & crashes after role.2.post -> resumeCycleWithPorts MUST refuse CAPABILITY_UNSUPPORTED!
    const runFmtCrash = 'run-delegated-format-crash';
    const yA2 = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runFmtCrash })));
    const yR2 = assertStepYield(assertOk(await stepSubmit({ runRoot, runId: runFmtCrash, leaseToken: yA2.leaseToken })));
    const badFile = join(f.root, 'not-a-verdict.json');
    await writeFile(badFile, '{"bad":true}', { mode: 0o600 });
    let threwAtPost = false;
    try {
      await stepSubmit(
        { runRoot, runId: runFmtCrash, leaseToken: yR2.leaseToken, submissionFile: badFile },
        {
          afterCheckpoint: async phase => {
            if (phase === 'role.2.post') throw new Error('crash right after review role.2.post');
          },
        },
      );
    } catch {
      threwAtPost = true;
    }
    // stepSubmit wraps errors in ControllerResult; verify failure or incident left role.2.post with review node 'failed'
    void threwAtPost;
    const resumedFmt = await resumeCycleWithPorts({ configuration: loaded, repository, runRoot, runId: runFmtCrash });
    assert.equal(resumedFmt.ok, false);
    if (!resumedFmt.ok) {
      assert.equal(resumedFmt.error.code, 'CAPABILITY_UNSUPPORTED');
      assert.equal(resumedFmt.error.path, '/spec/profiles/roles');
    }
  } finally {
    await f.cleanup();
  }
});

test('kind: check step with onRework triggers rework with StepReworkContext and halts blocked at maxReworks in both controller.ts (Pi) and step.ts (delegated)', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createGitRepo(repository, { 'packages/result.json': JSON.stringify({ ok: false }) });
    const installed = await installedHandlerDigests();

    // A. Pi controller.ts: implement -> verify (onRework: { rejectTo: implement, maxReworks: 2 })
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Implement result.json.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 0);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'implement', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['implement'], onRework: { rejectTo: 'implement', maxReworks: 2 } },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'implement', handlerRef: 'author.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const piLoaded = assertOk(await f.load(), 'load Pi check-rework fixture');

    const seenPrompts: string[] = [];
    let piAttempt = 0;
    const piRes = assertOk(
      await runCycleWithPorts(
        { configuration: piLoaded, repository, runRoot, runId: 'run-pi-check-rework' },
        {
          openAdapter: createPiMockPort(({ prompt }) => {
            piAttempt++;
            seenPrompts.push(prompt);
            return {
              files: { 'packages/result.json': JSON.stringify({ ok: piAttempt >= 2, attempt: piAttempt }) },
              responseJson: {
                version: 1,
                status: 'completed',
                checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
                reason: null,
              },
            };
          }),
        },
      ),
      'Pi check-step onRework run',
    );
    assert.equal(piRes.kind, 'result');
    if (piRes.kind === 'result') {
      assert.equal(piRes.result.spec.status, 'completed');
      assert.equal(piAttempt, 2);
      assert.match(seenPrompts[1]!, /from step "verify"/);
      assert.match(seenPrompts[1]!, /property_mismatch/);
      assert.equal(piRes.stepVerdicts?.length, 1);
      assert.equal(piRes.stepVerdicts?.[0]?.attemptId, null);
      assert.equal(piRes.stepVerdicts?.[0]?.stepId, 'verify');
      assert.equal(piRes.findings?.length, 1);
    }

    // B. Delegated step.ts: implement -> verify (onRework: { rejectTo: implement, maxReworks: 1 }) hits maxReworks -> halts blocked preserving findings!
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'del-builder', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write'], mcp: null },
    ]);
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'builder', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'builder', profileRef: 'del-builder' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'implement', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['implement'], onRework: { rejectTo: 'implement', maxReworks: 1 } },
    ]);
    await f.save();
    const delLoaded = assertOk(await f.load(), 'load delegated check-rework fixture');

    const delRunId = 'run-step-check-rework-cap';
    const y0 = assertStepYield(assertOk(await stepNext({ configuration: delLoaded, repository, runRoot, runId: delRunId })));
    assert.equal(y0.reworkEpoch, 0);
    await writeFile(join(y0.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: false, try: 1 }), { mode: 0o600 });
    const y1 = assertStepYield(assertOk(await stepSubmit({ runRoot, runId: delRunId, leaseToken: y0.leaseToken })));
    assert.equal(y1.stepId, 'implement');
    assert.equal(y1.reworkEpoch, 1);
    assert.equal(y1.rework?.fromStepId, 'verify');
    assert.equal(y1.rework?.findings.length, 1);
    assert.equal(y1.rework?.findings[0]?.path, 'packages/result.json');

    // Epoch 1 still fails check -> hits maxReworks: 1 -> halts blocked with both findings!
    await writeFile(join(y1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: false, try: 2 }), { mode: 0o600 });
    const halted = assertOk(await stepSubmit({ runRoot, runId: delRunId, leaseToken: y1.leaseToken }));
    assert.equal(halted.kind, 'result');
    if (halted.kind === 'result') {
      assert.equal(halted.result.spec.status, 'blocked');
      assert.equal(halted.stepVerdicts?.length, 2);
      assert.equal(halted.findings?.length, 2);
    }
  } finally {
    await f.cleanup();
  }
});

test('adoptRoleCapture enforces allowWorkflowWrites on Pi runs, and readStepMeta refuses symlink/corrupt step-meta.json and ports.allowWorkflowWrites mismatch', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createGitRepo(repository, {
      'packages/result.json': JSON.stringify({ ok: true }),
      '.github/workflows/ci.yml': 'name: CI\n',
      '.claude/secret.txt': 'secret\n',
    });
    const installed = await installedHandlerDigests();

    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Edit.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**', '.github/workflows/**'], protected: ['.claude/**'] });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'author.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const piLoaded = assertOk(await f.load(), 'load Pi workflow-guard fixture');

    const wfAdapter = createPiMockPort(() => ({
      files: { '.github/workflows/ci.yml': 'name: Edited\n' },
      responseJson: { version: 1, status: 'completed', checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }], reason: null },
    }));

    // 1. Default allowWorkflowWrites=false: Pi capture refuses ARTIFACT_INVALID (incident)!
    const piBlocked = assertOk(
      await runCycleWithPorts({ configuration: piLoaded, repository, runRoot, runId: 'run-pi-wf-deny' }, { openAdapter: wfAdapter }),
    );
    assert.equal(piBlocked.kind, 'incident');
    if (piBlocked.kind === 'incident') {
      assert.equal(piBlocked.incident.code, 'ARTIFACT_INVALID');
    }

    // 2. Host-gated allowWorkflowWrites=true: Pi capture allows .github/workflows/ci.yml!
    const piAllowed = assertOk(
      await runCycleWithPorts(
        { configuration: piLoaded, repository, runRoot, runId: 'run-pi-wf-allow' },
        { openAdapter: wfAdapter, allowWorkflowWrites: true },
      ),
    );
    assert.equal(piAllowed.kind, 'result');
    if (piAllowed.kind === 'result') {
      assert.equal(piAllowed.result.spec.status, 'completed');
    }

    // 3. Delegated step-meta.json tamper & ports.allowWorkflowWrites mismatch checks!
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'del-builder', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write'], mcp: null },
    ]);
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'builder', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'builder', profileRef: 'del-builder' }]);
    await f.save();
    const delLoaded = assertOk(await f.load(), 'load step-meta fixture');

    const runMeta = 'run-step-meta-guard';
    assertStepYield(assertOk(await stepNext({ configuration: delLoaded, repository, runRoot, runId: runMeta })));

    // Matching ports.allowWorkflowWrites=false succeeds, while conflicting ports.allowWorkflowWrites=true refuses RECOVERY_REQUIRED
    const yReissued = assertStepYield(
      assertOk(await stepNext({ runRoot, runId: runMeta, reissueLease: true }, { allowWorkflowWrites: false }), 'matching allowWorkflowWrites reopens cleanly'),
    );
    const portMismatchNext = await stepNext({ runRoot, runId: runMeta, reissueLease: true }, { allowWorkflowWrites: true });
    assert.equal(portMismatchNext.ok, false);
    if (!portMismatchNext.ok) {
      assert.equal(portMismatchNext.error.code, 'RECOVERY_REQUIRED');
    }
    const portMismatchSubmit = await stepSubmit({ runRoot, runId: runMeta, leaseToken: yReissued.leaseToken }, { allowWorkflowWrites: true });
    assert.equal(portMismatchSubmit.ok, false);
    if (!portMismatchSubmit.ok) {
      assert.equal(portMismatchSubmit.error.code, 'RECOVERY_REQUIRED');
    }

    // Corrupt step-meta.json refuses RECOVERY_REQUIRED (never silently falls back to default!)
    const metaPath = join(runRoot, runMeta, 'step-meta.json');
    await writeFile(metaPath, '{not-json', { mode: 0o600 });
    const corruptRes = await stepNext({ runRoot, runId: runMeta, reissueLease: true });
    assert.equal(corruptRes.ok, false);
    if (!corruptRes.ok) assert.equal(corruptRes.error.code, 'RECOVERY_REQUIRED');

    // Symlink step-meta.json refuses RECOVERY_REQUIRED!
    const outsideTarget = join(f.root, 'outside-meta.json');
    await writeFile(outsideTarget, JSON.stringify({ version: 1, mode: 'candidate', allowWorkflowWrites: true }), { mode: 0o600 });
    await unlink(metaPath);
    await symlink(outsideTarget, metaPath);
    const symlinkRes = await stepSubmit({ runRoot, runId: runMeta, leaseToken: yReissued.leaseToken });
    assert.equal(symlinkRes.ok, false);
    if (!symlinkRes.ok) assert.equal(symlinkRes.error.code, 'RECOVERY_REQUIRED');
  } finally {
    await f.cleanup();
  }
});

test('2-step Pi run with budgets.overlay (>128 files / >32 KiB manifest) passes schedulingSnapshot on step 2', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const baseFiles: Record<string, string> = { 'packages/result.json': JSON.stringify({ ok: true }) };
    // Create >128 baseline files so freezeSource uses v2 tree-anchored overlay mode
    for (let i = 0; i < 140; i++) {
      baseFiles[`src/base-${String(i).padStart(3, '0')}.txt`] = `base-${i}\n`;
    }
    const rev = await createGitRepo(repository, baseFiles);
    const installed = await installedHandlerDigests();

    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Generate many files.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review many files.', purpose: 'review' }, capabilities: ['pi'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 512, maxBytes: 8_388_608 });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'builder', dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load wide-overlay 2-step Pi fixture');

    const manyFiles: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      manyFiles[`packages/generated-wide-overlay-file-${String(i).padStart(3, '0')}.txt`] = `payload-${i}\n`;
    }
    let reviewExecuted = false;
    const res = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository, runRoot, runId: 'run-pi-wide-overlay-2step' },
        {
          openAdapter: createPiMockPort(({ stepId }) => {
            if (stepId === 'build') {
              return {
                files: manyFiles,
                responseJson: { version: 1, status: 'completed', checks: [], reason: null },
              };
            }
            reviewExecuted = true;
            return {
              responseJson: { verdict: 'pass', summary: 'Wide overlay reviewed cleanly', findings: [] },
            };
          }),
        },
      ),
      '2-step Pi wide-overlay run',
    );
    // Step 2 MUST execute (proving schedulingSnapshot accepted the >128 file / >32 KiB manifest)!
    assert.equal(reviewExecuted, true);
    assert.ok(res.kind === 'result' || res.kind === 'incident');
  } finally {
    await f.cleanup();
  }
});

test('controller.ts: rework with modified candidate resets non-subgraph completed checks to pending and dedupes role resourceIds', async () => {
  const { selectRoleResources } = await import('../src/config.js');
  assert.deepEqual(
    selectRoleResources([{ id: 'impl-doc' }, { id: 'other' }], ['impl-doc', 'impl-doc'], 'compile'),
    [{ id: 'impl-doc' }],
  );
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createGitRepo(repository, {
      'packages/pre.json': JSON.stringify({ pre: true }),
      'packages/result.json': JSON.stringify({ ok: false }),
    });
    const installed = await installedHandlerDigests();
    const resImplBytes = Buffer.from('Impl resource bytes\n', 'utf8');
    const resImpl = { id: 'impl-doc', kind: 'instruction' as const, path: 'impl.md', digest: hash(resImplBytes) };
    await writeFile(join(f.operator, resImpl.path), resImplBytes, { mode: 0o600 });

    const baseProfile = f.registry.spec.roleProfiles[0]!;
    const writeProfile = { ...baseProfile, id: 'writer', tools: ['read', 'write', 'edit'] };
    const readProfile = { ...baseProfile, id: 'reader', tools: ['read'] };
    setFixture(f.registry, ['spec', 'roleProfiles'], [writeProfile, readProfile]);
    setFixture(f.registry, ['spec', 'resources'], [resImpl]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'pre-check.h', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'pre-check', path: 'packages/pre.json', required: ['pre'], equals: { pre: true } }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'impl.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Implement change.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'post-check.h', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'post-check', path: 'packages/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review change.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['pre-check', 'post-check'],
      checks: [
        { id: 'pre-check', allowedEvidenceLevels: ['local_execution'] },
        { id: 'post-check', allowedEvidenceLevels: ['local_execution'] },
      ],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [resImpl]);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'implementer', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read', 'write', 'edit'], resourceIds: ['impl-doc'] },
      { id: 'reviewer', adapter: 'pi', provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', tools: ['read'], resourceIds: [] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'implementer', profileRef: 'writer' },
      { roleId: 'reviewer', profileRef: 'reader' },
    ]);
    // pre-check runs BEFORE implement (outside the rejectTo: 'implement' rework subgraph!),
    // while post-check runs inside the rework subgraph using the same json-artifact.v1 implementation.
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'pre-check', kind: 'check', uses: 'pre-check.h', roleId: null, dependsOn: [] },
      { id: 'implement', kind: 'agent', uses: 'impl.h', roleId: 'implementer', dependsOn: ['pre-check'] },
      { id: 'post-check', kind: 'check', uses: 'post-check.h', roleId: null, dependsOn: ['implement'] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['post-check'], onRework: { rejectTo: 'implement', maxReworks: 2 } },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'pre-check', handlerRef: 'pre-check.h' },
      { stepId: 'implement', handlerRef: 'impl.h' },
      { stepId: 'post-check', handlerRef: 'post-check.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 10);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 20);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load pre-check rework fixture');

    let implCalls = 0;
    let reviewCalls = 0;
    let observedImplResources: readonly string[] = [];
    const res = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository, runRoot, runId: 'run-rework-upstream-check' },
        {
          openAdapter: createPiMockPort(({ stepId, resourceIds }) => {
            if (stepId === 'implement') {
              implCalls += 1;
              observedImplResources = resourceIds;
              return {
                // Only mutate on Epoch 0; Epoch 1 leaves candidate bytes unchanged so generation stays at the rework-incremented generation!
                ...(implCalls === 1 ? { files: { 'packages/result.json': JSON.stringify({ ok: true, iteration: 1 }) } } : {}),
                responseJson: { version: 1, status: 'completed', checks: [{ checkId: 'pre-check', status: 'passed', evidenceId: null, reason: null }, { checkId: 'post-check', status: 'passed', evidenceId: null, reason: null }], reason: null },
              };
            }
            reviewCalls += 1;
            if (reviewCalls === 1) {
              return {
                responseJson: { verdict: 'rework', summary: 'Re-verify after rework', findings: [{ title: 'Iter', severity: 'low', evidence: 'iteration=1' }] } satisfies StepVerdict,
              };
            }
            return {
              responseJson: { verdict: 'pass', summary: 'Looks good on iteration 2', findings: [] } satisfies StepVerdict,
            };
          }),
        },
      ),
      'run rework with upstream non-subgraph check',
    );
    assert.deepEqual(observedImplResources, ['impl-doc'], 'duplicate role resourceIds must be deduplicated');
    assert.equal(implCalls, 2, JSON.stringify({ implCalls, reviewCalls, res }));
    assert.equal(reviewCalls, 2);
    assert.equal(res.kind, 'result');
    if (res.kind === 'result') {
      assert.equal(res.result.spec.status, 'completed');
      const preRow = res.result.spec.verification.spec.required.find(r => r.checkId === 'pre-check');
      const postRow = res.result.spec.verification.spec.required.find(r => r.checkId === 'post-check');
      assert.equal(preRow?.status, 'passed');
      assert.equal(postRow?.status, 'passed');
    }
  } finally {
    await f.cleanup();
  }
});
