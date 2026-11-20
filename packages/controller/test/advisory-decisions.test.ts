import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInputV2, PiOutcomeV2 } from '@loopwright/agent-pi';
import {
  inspectRun,
  installedHandlerDigests,
  runCycleWithPorts,
  stepNext,
  stepSubmit,
  type AdvisoryDecisionPort,
  type CandidateDiffTriageInput,
  type CandidateDiffTriageOutput,
  type CapabilityRoutingDecisionInput,
  type CycleAlignmentDecisionInput,
  type SoftCompactionDecisionInput,
  type StepTickResult,
  type StepYield,
} from '../src/index.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';

function assertOk<T>(res: { readonly ok: boolean; readonly value?: T; readonly error?: unknown }, msg = ''): T {
  assert.equal(res.ok, true, `${msg}: ${JSON.stringify(res.error)}`);
  return res.value as T;
}

function assertStepYield(tick: StepTickResult): StepYield {
  assert.equal(tick.kind, 'step');
  if (tick.kind !== 'step') throw new Error('expected step');
  return tick;
}

function buildPiAdapterPort(options: {
  readonly onExecute: (stepId: string, prompt: string, repair: string) => {
    readonly files?: Readonly<Record<string, string>>;
    readonly responseJson: unknown;
    readonly inputTokens?: number;
  };
  readonly onCompact?: () => void;
}) {
  let seq = 0;
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
    let files = new Map<string, Uint8Array>(
      await Promise.all(
        input.candidate.artifacts.map(async a => [
          a.name,
          'bytes' in a ? new Uint8Array(a.bytes) : new Uint8Array(await readFile(a.blobPath)),
        ] as const),
      ),
    );
    let lastText = '';
    let responseText = JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null });
    let lastWasCompaction = false;

    const recordTurn = async (purpose: 'task' | 'reviewer' | 'compaction', repair: 'none' | 'format' | 'implementation', cmdId: string, inTok: number) => {
      seq++;
      const reqId = `adv-req-${seq}`;
      const opId = `adv-op-${seq}`;
      stateValue(
        host.store.reserveRequest(host.authority, {
          requestId: reqId,
          roleId: input.roleId,
          nodeId: input.stepId,
          attemptId: cmdId,
          purpose,
          repair,
          transportRetryOf: null,
          requestDigest: hash(`adv-${seq}`),
          inputUpperBound: inTok + 50,
          outputUpperBound: 50,
          totalUpperBound: inTok + 100,
          capability: {
            adapterId: 'pi',
            adapterVersion: '0.0.0',
            provider: input.policy.selection.provider,
            model: input.policy.selection.model,
            kind: 'soft_only',
            coversAllBillableTokens: false,
            enforcesOutputBound: false,
          },
          operationId: opId,
          targetIdentity: 'fixture:advisory-pi',
        }),
      );
      stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
      const op = stateValue(host.store.getOperation(opId));
      const view = stateValue(host.store.inspect());
      const uBytes = Buffer.from(canonical({ seq }));
      const uName = `adv-u-${hash(uBytes).hex}.bin`;
      await writeFile(join(host.artifactsDirectory, uName), uBytes, { mode: 0o600 });
      stateValue(
        host.store.observeRequest(host.authority, reqId, {
          receiptId: `adv-rec-${seq}`,
          termination: 'confirmed',
          outcome: 'succeeded',
          evidence: {
            evidenceId: `adv-ev-${seq}`,
            producerId: 'adv-mock',
            method: 'synthetic',
            artifact: { name: uName, byteLength: uBytes.byteLength, digest: hash(uBytes) },
            subject: {
              storeId: view.storeId,
              runId: view.runId,
              lockHash: view.lockHash,
              operationId: opId,
              requestId: reqId,
              intentDigest: op.intentDigest,
              dispatchGeneration: op.dispatch!.generation,
              dispatchId: op.dispatch!.dispatchId,
            },
          },
          usage: {
            requestId: reqId,
            inputTokens: { provenance: 'reported', value: inTok },
            outputTokens: { provenance: 'reported', value: 10 },
            costMicrousd: { provenance: 'reported', value: 100 },
          },
        }),
      );
      return { reqId, opId };
    };

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
      compact: async ({ commandId }) => {
        lastWasCompaction = true;
        options.onCompact?.();
        const { reqId, opId } = await recordTurn('compaction', 'none', commandId, 50);
        return {
          ok: true,
          value: {
            status: 'execution_settled',
            requestIds: [reqId],
            operationIds: [opId],
            providerTermination: 'confirmed',
            usage: 'complete',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        };
      },
      execute: async cmd => {
        lastWasCompaction = false;
        lastText = cmd.text;
        const plan = options.onExecute(input.stepId, cmd.text, cmd.repair);
        if (plan.files) {
          files = new Map(files);
          for (const [k, v] of Object.entries(plan.files)) files.set(k, new Uint8Array(Buffer.from(v, 'utf8')));
        }
        responseText = JSON.stringify(plan.responseJson);
        const mappedPurpose: 'task' | 'reviewer' | 'compaction' =
          cmd.purpose === 'reviewer' || cmd.purpose === 'compaction' ? cmd.purpose : 'task';
        const { reqId, opId } = await recordTurn(mappedPurpose, cmd.repair, cmd.commandId, plan.inputTokens ?? 100);
        return {
          ok: true,
          value: {
            status: 'execution_settled',
            requestIds: [reqId],
            operationIds: [opId],
            providerTermination: 'confirmed',
            usage: 'complete',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        };
      },
      capture: async ({ checkpointId }) => {
        const sorted = [...files.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, bytes]) => ({ name, bytes, ref: { name, byteLength: bytes.byteLength, digest: hash(bytes) } }));
        const manifest = {
          apiVersion: 'loopwright.dev/v1alpha1' as const,
          kind: 'ArtifactManifest' as const,
          metadata: { id: 'candidate' },
          spec: { entries: sorted.map(s => s.ref) },
        };
        const current = stateValue(host.store.inspect());
        const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
        const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
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
          accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })),
          sequence: 1,
        };
        const line = (v: unknown) => JSON.stringify(v) + '\n';
        let wsBody = line({ type: 'workspace_snapshot', version: 1, binding, manifest });
        for (const s of sorted) {
          wsBody += line({ type: 'file', ref: s.ref });
          if (s.bytes.byteLength > 0) wsBody += line({ type: 'chunk', index: 0, data: Buffer.from(s.bytes).toString('base64') });
          wsBody += line({ type: 'file_end', byteLength: s.bytes.byteLength, digest: s.ref.digest.hex });
        }
        wsBody += line({ type: 'end', files: sorted.length });
        const wsBytes = Buffer.from(wsBody, 'utf8');
        const wsName = `adv-ws-${hash(wsBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
        const wsRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };

        const ts = '2026-11-19T00:00:00.000Z';
        const sessBody =
          line({ type: 'session_snapshot', version: 1, binding }) +
          line({ type: 'session', version: 3, id: 's1', cwd: '/workspace/candidate', timestamp: ts }) +
          (lastWasCompaction
            ? line({ type: 'message', id: 'u0', parentId: null, timestamp: ts, message: { role: 'user', content: 'prior' } }) +
              line({
                type: 'message',
                id: 'a0',
                parentId: 'u0',
                timestamp: ts,
                message: { role: 'assistant', ...input.policy.selection, content: [{ type: 'text', text: '{}' }], stopReason: 'stop' },
              }) +
              line({ type: 'compaction', id: 'c1', parentId: 'a0', timestamp: ts, summary: 'compacted', firstKeptEntryId: 'a0', tokensBefore: 100 })
            : line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastText } }) +
              line({
                type: 'message',
                id: 'a1',
                parentId: 'u1',
                timestamp: ts,
                message: { role: 'assistant', ...input.policy.selection, content: [{ type: 'text', text: responseText }], stopReason: 'stop' },
              }));
        const sessBytes = Buffer.from(sessBody, 'utf8');
        const sessName = `adv-sess-${hash(sessBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
        const sessRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };

        stateValue(
          host.store.writeCheckpoint(host.authority, {
            checkpointId,
            expectedRevision: stateValue(host.store.inspect()).revision,
            candidateManifest: manifest,
            workspace: wsRef,
            privateSession: sessRef,
            additionalArtifacts: [],
          }),
        );
        return { ok: true, value: { checkpointId, candidate: manifest, workspace: wsRef, session: sessRef } };
      },
    };
    return { ok: true as const, value: adapter };
  };
}

test('ControllerPorts.decisions invokes evaluateCycleAlignment, adviseSoftCompaction, and triageCandidateDiff with deterministic fallback and zero authority elevation', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(join(repository, 'packages', 'core'), { recursive: true, mode: 0o700 });
    await writeFile(join(repository, 'packages', 'core', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
      });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Adv Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const rev = git(['rev-parse', 'HEAD']).trim();

    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'build.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Build.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'compact.h', kind: 'agent', implementation: 'pi.compact.v1', version: 1, digest: installed['pi.compact.v1'], parameters: {}, capabilities: ['pi', 'compaction'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/core/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'totalTokens'], 1200);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'perCallOutputTokens'], 256);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'build.h', roleId: 'builder', dependsOn: [] },
      { id: 'compact', kind: 'agent', uses: 'compact.h', roleId: 'builder', dependsOn: ['build'] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['compact'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'build.h' },
      { stepId: 'compact', handlerRef: 'compact.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load advisory fixture');

    const cycleCalls: CycleAlignmentDecisionInput[] = [];
    const compactCalls: SoftCompactionDecisionInput[] = [];
    const triageCalls: CandidateDiffTriageInput[] = [];
    let compactedCount = 0;
    let buildTurn = 0;

    // 1. Happy path + attempted authority elevation (`verificationCertified: true` & hard-compaction `'defer'` veto)
    const decisions1: AdvisoryDecisionPort = {
      evaluateCycleAlignment: async input => {
        cycleCalls.push(input);
        return { route: 'revise', precheckPassed: true, source: 'jev' };
      },
      adviseSoftCompaction: async input => {
        compactCalls.push(input);
        // Attempt to veto compaction even when contextUtilization >= 0.8 (850 / 1000 = 0.85)!
        return { advisoryDecision: 'defer', source: 'jev' };
      },
      triageCandidateDiff: async input => {
        triageCalls.push(input);
        // Attempt illegal authority elevation `verificationCertified: true` on a broken `{ ok: false }` candidate!
        return {
          escalated: [{ ruleId: 'check-ok', severity: 'blocking', source: 'jev', advisoryOnly: true }],
          verificationCertified: true as unknown as false,
          source: 'jev',
        } satisfies CandidateDiffTriageOutput;
      },
    };

    const openAdapter1 = buildPiAdapterPort({
      onCompact: () => {
        compactedCount++;
      },
      onExecute: (_stepId, _prompt, repair) => {
        buildTurn++;
        const okVal = repair === 'implementation' || buildTurn > 1;
        return {
          // Turn 1: 990 + 10 = 1000 / 1200 => contextUtilization = 0.833 >= 0.80 hard trigger!
          // Compact: 50 + 10 = 60, Turn 2 (repair): 20 + 10 = 30 => total 1090 <= 1200!
          inputTokens: buildTurn === 1 ? 990 : 20,
          files: { 'packages/core/result.json': JSON.stringify({ ok: okVal, turn: buildTurn }) },
          responseJson: {
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          },
        };
      },
    });

    const res1 = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository, runRoot, runId: 'run-adv-happy' },
        { openAdapter: openAdapter1, decisions: decisions1 },
      ),
      'advisory cycle 1',
    );
    assert.equal(res1.kind, 'result');
    if (res1.kind === 'result') {
      // Verification was NOT certified by triageCandidateDiff on turn 1; independent verifier failed turn 1,
      // evaluateCycleAlignment allowed repair, and turn 2 passed real verification!
      assert.equal(res1.result.spec.status, 'completed');
      assert.equal(buildTurn, 2);
      assert.equal(compactedCount, 1); // Hard-trigger compaction veto was refused!
      assert.equal(compactCalls.length, 1);
      assert.ok(compactCalls[0]!.contextUtilization >= 0.8);
      assert.equal(cycleCalls.length, 1);
      assert.equal(cycleCalls[0]!.trigger, 'implementation_repair');
      assert.equal(triageCalls.length, 2);
      assert.deepEqual(triageCalls[0]!.summary.changedFiles, ['packages/core/result.json']);
      assert.deepEqual(triageCalls[0]!.summary.touchedPackages, ['core']);

      const obs = JSON.parse(await readFile(join(runRoot, 'run-adv-happy', 'artifacts', res1.observations!.name), 'utf8')) as Record<string, unknown>;
      assert.ok(Array.isArray(obs.advisoryDecisions));
    }

    // 2. Thrown errors in ALL AdvisoryDecisionPort hooks fall back deterministically without crashing the run!
    let throwingTurn = 0;
    const throwingDecisions: AdvisoryDecisionPort = {
      routeCapabilityTier: async () => {
        throw new Error('TRANSPORT_DOWN_CAPABILITY');
      },
      evaluateCycleAlignment: async () => {
        throw new Error('TRANSPORT_DOWN_CYCLE');
      },
      adviseSoftCompaction: async () => {
        throw new Error('TRANSPORT_DOWN_COMPACT');
      },
      triageCandidateDiff: async () => {
        throw new Error('TRANSPORT_DOWN_TRIAGE');
      },
    };
    const openAdapter2 = buildPiAdapterPort({
      onExecute: (_stepId, _prompt, repair) => {
        throwingTurn++;
        return {
          inputTokens: 100,
          files: { 'packages/core/result.json': JSON.stringify({ ok: repair === 'implementation', turn: throwingTurn }) },
          responseJson: {
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          },
        };
      },
    });
    const res2 = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository, runRoot, runId: 'run-adv-throws' },
        { openAdapter: openAdapter2, decisions: throwingDecisions },
      ),
      'advisory cycle throwing fallback',
    );
    assert.equal(res2.kind, 'result');
    if (res2.kind === 'result') {
      assert.equal(res2.result.spec.status, 'completed');
      assert.equal(throwingTurn, 2);
    }

    // 3. step.ts parity: ControllerPorts.decisions invoked in delegated stepSubmit & evaluateCycleAlignment 'blocked' stops rework/repair cleanly
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
      { id: 'build', kind: 'agent', uses: 'build.h', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'build.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    await f.save();
    const delLoaded = assertOk(await f.load(), 'load delegated advisory fixture');

    let stepTriageCount = 0;
    let stepCycleAlignCount = 0;
    const stepDecisions: AdvisoryDecisionPort = {
      triageCandidateDiff: async () => {
        stepTriageCount++;
        return { escalated: [], verificationCertified: false, source: 'deterministic_heuristic' };
      },
      evaluateCycleAlignment: async () => {
        stepCycleAlignCount++;
        return { route: 'blocked', precheckPassed: false, source: 'deterministic_heuristic' };
      },
    };
    const sYield = assertStepYield(
      assertOk(await stepNext({ configuration: delLoaded, repository, runRoot, runId: 'run-adv-step' }, { decisions: stepDecisions })),
    );
    // Pinned model preserved!
    assert.equal(sYield.selection.model, 'gemini-4-carbon');
    // Leave result.json with { ok: false } -> verify fails -> evaluateCycleAlignment returns 'blocked', halting repair without extra yield!
    await writeFile(join(sYield.candidateDir, 'packages', 'core', 'result.json'), JSON.stringify({ ok: false, edited: true }), { mode: 0o600 });
    const stepSettled = assertOk(
      await stepSubmit({ runRoot, runId: 'run-adv-step', leaseToken: sYield.leaseToken }, { decisions: stepDecisions }),
    );
    assert.equal(stepTriageCount, 1);
    assert.equal(stepCycleAlignCount, 1);
    assert.equal(stepSettled.kind, 'result');
    if (stepSettled.kind === 'result') {
      assert.equal(stepSettled.result.spec.status, 'failed');
      // Verify stepSubmit preserved advisoryDecisions from stepSubmit's Cycle into terminal observations!
      assert.ok(stepSettled.observations);
      const obsRaw = JSON.parse(await readFile(join(runRoot, 'run-adv-step', 'artifacts', stepSettled.observations.name), 'utf8')) as Record<string, unknown>;
      const advList = obsRaw.advisoryDecisions as readonly Record<string, unknown>[];
      assert.ok(Array.isArray(advList));
      assert.ok(advList.some(item => item.intent === 'triage_candidate_diff'));
      assert.ok(advList.some(item => item.intent === 'evaluate_cycle_alignment'));
    }
  } finally {
    await f.cleanup();
  }
});

test('AdvisoryDecisionPort validates return enums, diffs classic-repo baselines, passes candidateSkills in both controller.ts and step.ts, and preserves valid observations JSON', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    await mkdir(join(repository, 'packages', 'core'), { recursive: true, mode: 0o700 });
    await mkdir(join(repository, 'src'), { recursive: true, mode: 0o700 });
    await writeFile(join(repository, 'src', 'untouched.ts'), 'export const keep = 1;\n', { mode: 0o600 });
    await writeFile(join(repository, 'packages', 'core', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
    const git = (args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: repository,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: '/nonexistent', GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8',
      });
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', 'user.name=Adv Enum Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'init']);
    const rev = git(['rev-parse', 'HEAD']).trim();

    const skillBytes = Buffer.from('# Skill A\n');
    const instrBytes = Buffer.from('# Instruction A\n');
    const skillRes = { id: 'skill-a', kind: 'skill' as const, path: 'skill-a.md', digest: hash(skillBytes) };
    const instrRes = { id: 'instr-a', kind: 'instruction' as const, path: 'instr-a.md', digest: hash(instrBytes) };
    await writeFile(join(f.operator, skillRes.path), skillBytes, { mode: 0o600 });
    await writeFile(join(f.operator, instrRes.path), instrBytes, { mode: 0o600 });

    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'resources'], [skillRes, instrRes]);
    setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [skillRes, instrRes]);
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'build.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Build.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'compact.h', kind: 'agent', implementation: 'pi.compact.v1', version: 1, digest: installed['pi.compact.v1'], parameters: {}, capabilities: ['pi', 'compaction'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/core/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles', 0, 'resourceIds'], ['skill-a', 'instr-a']);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'build.h', roleId: 'builder', dependsOn: [] },
      { id: 'compact', kind: 'agent', uses: 'compact.h', roleId: 'builder', dependsOn: ['build'] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['compact'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'build.h' },
      { stepId: 'compact', handlerRef: 'compact.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load invalid-enum fixture');

    const piRouteCalls: CapabilityRoutingDecisionInput[] = [];
    const piTriageCalls: CandidateDiffTriageInput[] = [];
    let turn = 0;

    // Return invalid/undefined enum values from every hook!
    const badEnumDecisions: AdvisoryDecisionPort = {
      routeCapabilityTier: async input => {
        piRouteCalls.push(input);
        return { tier: undefined as unknown as 'fast', source: 'bogus_source' as unknown as 'jev' };
      },
      adviseSoftCompaction: async () => ({
        advisoryDecision: 'invalid_action' as unknown as 'compact',
        source: undefined as unknown as 'jev',
      }),
      evaluateCycleAlignment: async () => ({
        route: undefined as unknown as 'continue',
        precheckPassed: true,
        source: 'not_an_enum' as unknown as 'jev',
      }),
      triageCandidateDiff: async input => {
        piTriageCalls.push(input);
        return {
          escalated: [],
          verificationCertified: false,
          source: undefined as unknown as 'jev',
        };
      },
    };

    const openAdapter = buildPiAdapterPort({
      onExecute: () => {
        turn++;
        return {
          files: { 'packages/core/result.json': JSON.stringify({ ok: turn >= 2, turn }) },
          responseJson: {
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          },
        };
      },
    });

    const piRes = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository, runRoot, runId: 'run-adv-bad-enums' },
        { openAdapter, decisions: badEnumDecisions },
      ),
      'runCycle with invalid advisory enum outputs',
    );
    assert.equal(piRes.kind, 'result');
    if (piRes.kind === 'result') {
      assert.equal(piRes.result.spec.status, 'completed');
      assert.ok(piRes.observations);
      // Verify routeCapabilityTier received only 'skill' resources!
      assert.ok(piRouteCalls.length >= 1);
      assert.deepEqual(piRouteCalls[0]!.candidateSkills, ['skill-a']);
      // Verify classic-repo baseline diff excluded untouched src/untouched.ts!
      assert.ok(piTriageCalls.length >= 1);
      assert.deepEqual(piTriageCalls[0]!.summary.changedFiles, ['packages/core/result.json']);
      // Verify observations JSON is valid and inspectRun returns status.source === 'current'!
      const obsRaw = JSON.parse(await readFile(join(runRoot, 'run-adv-bad-enums', 'artifacts', piRes.observations.name), 'utf8')) as Record<string, unknown>;
      const advList = obsRaw.advisoryDecisions as readonly Record<string, unknown>[];
      assert.ok(advList.length >= 4);
      assert.ok(advList.every(item => item.source === 'deterministic_fallback'));
      const inspected = assertOk(await inspectRun({ runRoot, runId: 'run-adv-bad-enums' }), 'inspectRun bad enums');
      assert.equal(inspected.status.source, 'current');
    }

    // Delegated step.ts parity: routeCapabilityTier receives candidateSkills!
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'del-builder', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write'], mcp: null },
    ]);
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'builder', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write'], resourceIds: ['skill-a', 'instr-a'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'builder', profileRef: 'del-builder' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'build.h', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['build'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'build.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    await f.save();
    const delLoaded = assertOk(await f.load(), 'load delegated skill-routing fixture');

    const stepRouteCalls: CapabilityRoutingDecisionInput[] = [];
    const stepTriageCalls: CandidateDiffTriageInput[] = [];
    const delDecisions: AdvisoryDecisionPort = {
      routeCapabilityTier: async input => {
        stepRouteCalls.push(input);
        return { tier: 'balanced', source: 'jev' };
      },
      triageCandidateDiff: async input => {
        stepTriageCalls.push(input);
        return { escalated: [], verificationCertified: false, source: 'jev' };
      },
    };
    const delYield = assertStepYield(
      assertOk(await stepNext({ configuration: delLoaded, repository, runRoot, runId: 'run-adv-step-skills' }, { decisions: delDecisions })),
    );
    assert.equal(stepRouteCalls.length, 1);
    assert.deepEqual(stepRouteCalls[0]!.candidateSkills, ['skill-a']);
    await writeFile(join(delYield.candidateDir, 'packages', 'core', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const delDone = assertOk(
      await stepSubmit({ runRoot, runId: 'run-adv-step-skills', leaseToken: delYield.leaseToken }, { decisions: delDecisions }),
    );
    assert.equal(delDone.kind, 'result');
    assert.equal(stepTriageCalls.length, 1);
    assert.deepEqual(stepTriageCalls[0]!.summary.changedFiles, ['packages/core/result.json']);
  } finally {
    await f.cleanup();
  }
});
