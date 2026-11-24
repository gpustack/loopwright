import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  admitTask,
  bindSubject,
  constructRunResult,
  type ArtifactManifest,
  type Digest,
  type Evidence,
  type EvidenceLevel,
  type RunStatus,
  type TaskContract,
} from '@loopwright/core';
import { applyMemoryProposalCAS } from '../src/cas.js';
import { finalizeRunMemory } from '../src/finalizer.js';
import {
  canonical,
  hashDomain,
  memoryEntrySchema,
  parseEntryMarkdown,
  renderEntryMarkdown,
  storeDigestOf,
  MemoryDiagnosticError,
} from '../src/schema.js';
import { loadMemoryStore, memoryDirectoryFor } from '../src/store.js';
import { selectActiveMemory } from '../src/selector.js';
import { verifyMemoryProposal } from '../src/verifier.js';
import type {
  HardwareMemoryScope,
  MemoryBudgetLedger,
  MemoryEntry,
  MemoryFinalizerConfig,
  MemoryProposal,
  MemoryStoreIndex,
  MemoryVerificationInput,
} from '../src/types.js';
import {
  BASE_REVISION,
  SOURCE_REVISION,
  artifactOf,
  digestOf,
  inventoryMap,
  refOf,
  type RunFixture,
} from './run-fixtures.js';

function hex(seed: string): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(seed).digest('hex') };
}

function makeContract(
  allowedEvidenceLevels: readonly EvidenceLevel[] = ['local_execution'],
  accelerator = 'sm_100a',
): TaskContract {
  const isHardware = allowedEvidenceLevels.includes('hardware_execution');
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'TaskContract',
    spec: {
      goal: 'hardware kernel optimization',
      taskpack: 'demo',
      target: {
        repository: 'org/repo',
        baseRevision: BASE_REVISION,
        sourceRevision: SOURCE_REVISION,
        matrix: isHardware
          ? [
              {
                id: 'cuda-b200',
                platform: 'linux-x86_64',
                variant: 'cuda',
                hardware: {
                  accelerator,
                  isolationMode: 'whole_device',
                  deviceCount: 1,
                },
              },
            ]
          : null,
      },
      scope: { writable: ['src/**'], protected: [] },
      roles: [{ id: 'coder', adapter: 'pi', provider: 'prov', model: 'model', thinking: 'off', tools: [] }],
      trustedContext: { revision: 'rev.one', discovery: 'disabled', resources: [] },
      budgets: {
        wallTimeMs: 60000,
        totalTokens: 10000,
        perCallOutputTokens: 2000,
        maxModelCalls: 10,
        maxConcurrency: 2,
        maxFormatRepairs: 2,
        maxImplementationRepairs: 3,
        maxTransportRetries: 3,
        enforcement: {
          wallTime: 'soft_accounting',
          tokens: 'soft_accounting',
          modelCalls: 'soft_accounting',
          concurrency: 'soft_accounting',
          formatRepairs: 'soft_accounting',
          implementationRepairs: 'soft_accounting',
          transportRetries: 'soft_accounting',
        },
      },
      steps: [{ id: 'work', kind: 'agent', uses: 'work', roleId: 'coder', dependsOn: [] }],
      acceptance: {
        required: ['check.bench'],
        checks: [
          {
            id: 'check.bench',
            allowedEvidenceLevels: [...allowedEvidenceLevels],
            ...(isHardware ? { targetCellId: 'cuda-b200' } : {}),
          },
        ],
      },
    },
  };
}

function buildHardwareRun(options: {
  readonly status: RunStatus;
  readonly level: EvidenceLevel;
  readonly accelerator?: string;
  readonly runId?: string;
}): RunFixture {
  const contract = makeContract([options.level], options.accelerator ?? 'sm_100a');
  const runId = options.runId ?? 'run.hw.one';
  const admitted = admitTask(contract, { admissionId: 'admission.hw', runId });
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.errors));
  const lock = admitted.value;
  const candidate = artifactOf('candidate.bin', 'candidate-body');
  const manifest: ArtifactManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [refOf(candidate)] },
  };
  const bound = bindSubject(lock, manifest);
  if (!bound.ok) throw new Error(JSON.stringify(bound.errors));
  const subject = bound.value;
  const evidenceBytes = artifactOf('evidence-bench.bin', `evidence for ${runId} ${options.status}`);
  const passed = options.status === 'completed' || options.status === 'no_change';
  const observedStatus = passed ? 'passed' : options.status === 'blocked' ? 'blocked' : 'failed';
  const hardwareProvenance = options.level === 'hardware_execution'
    ? {
        targetCellId: 'cuda-b200',
        probeKind: 'physical' as const,
        vendor: 'nvidia',
        deviceModel: 'B200',
        accelerator: options.accelerator ?? 'sm_100a',
        isolationMode: 'whole_device' as const,
        deviceCount: 1,
        driverVersion: '570.124.06',
        runtimeVersion: 'cuda-12.8',
        workloadDigest: hex('workload'),
        clockLockMode: 'locked' as const,
      }
    : undefined;
  const evidence: Evidence = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Evidence',
    metadata: { id: 'evidence.check.bench' },
    spec: {
      checkId: 'check.bench',
      observedStatus: observedStatus as Evidence['spec']['observedStatus'],
      producerId: 'producer.hw',
      method: 'method.bench',
      level: options.level,
      subject,
      artifacts: [refOf(evidenceBytes)],
      reason: passed ? null : `fixture ${options.status} observation`,
      ...(hardwareProvenance === undefined ? {} : { hardwareProvenance }),
    },
  };
  const claims = [
    {
      checkId: 'check.bench',
      status: observedStatus as 'passed' | 'failed' | 'blocked',
      evidenceId: evidence.metadata.id,
      reason: passed ? null : `fixture ${options.status} failure`,
    },
  ];
  const built = constructRunResult(
    {
      trusted: {
        expectedLock: lock,
        candidateManifest: manifest,
        eligibleEvidence: [evidence],
        usage: [],
        externalEffects: 'none',
        noChange: null,
      },
      candidate: { status: options.status, checks: claims, memory: { status: 'not_requested', reason: null } },
    },
    [candidate, evidenceBytes],
  );
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return {
    lock,
    result: built.value,
    evidence: [evidence],
    manifest,
    artifactRefs: [refOf(candidate), refOf(evidenceBytes)],
  };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const base: MemoryEntry = {
    version: 1,
    id: 'entry.alpha',
    claimKey: 'claim.alpha',
    claim: 'Stable claim text.',
    kind: 'fact',
    scope: { taskpack: 'demo', repository: 'org/repo', paths: ['src/**'], targetMatrix: null },
    sourceRef: { runId: 'run.hw.one', lockHash: hex('lock'), candidateDigest: hex('candidate') },
    sourceDigest: hex('source'),
    verifiedAtMs: 1000,
    validFor: {
      baseRevision: BASE_REVISION,
      sourceRevision: SOURCE_REVISION,
      codeFingerprint: hex('fingerprint'),
      upstreamVersions: { npm: '1.0.0' },
    },
    expiresAtMs: 5000,
    supersedes: [],
    evidenceRefs: [
      {
        evidenceId: 'evidence.check.bench',
        checkId: 'check.bench',
        level: 'local_execution',
        observedStatus: 'passed',
        artifact: { name: 'evidence-bench.bin', digest: hex('artifact'), byteLength: 10 },
      },
    ],
  };
  return Object.freeze({ ...base, ...overrides }) as MemoryEntry;
}

function makeStore(entries: readonly MemoryEntry[]): MemoryStoreIndex {
  const base = {
    version: 1 as const,
    taskpack: 'demo',
    repository: 'org/repo',
    updatedAtMs: 1500,
    entries,
    retired: [],
  };
  return { ...base, storeDigest: storeDigestOf(base) };
}

function proposalForEntry(fixture: RunFixture, store: MemoryStoreIndex, entry: MemoryEntry): MemoryProposal {
  return {
    version: 1,
    proposalId: 'proposal.hw.one',
    taskpack: 'demo',
    repository: 'org/repo',
    baseRevision: BASE_REVISION,
    baseStoreDigest: store.storeDigest,
    createdAtMs: 1500,
    runId: fixture.lock.spec.runId,
    lockHash: fixture.lock.spec.lockHash,
    operations: [{ kind: 'upsert', entry }],
  };
}

function verifyInputFor(fixture: RunFixture, store: MemoryStoreIndex, proposal: MemoryProposal): MemoryVerificationInput {
  return {
    proposal,
    store,
    lock: fixture.lock,
    result: fixture.result,
    incident: null,
    evidence: fixture.evidence,
    artifacts: new Map(fixture.artifactRefs.map(ref => [ref.name, { byteLength: ref.byteLength, digest: ref.digest }])),
    candidateDigest: fixture.result.spec.subject.candidateDigest,
    patch: '',
    secretValues: [],
    memoryWritable: [memoryDirectoryFor('demo')],
    protectedPaths: [],
  };
}

function entryBoundToFixture(
  fixture: RunFixture,
  overrides: {
    readonly id?: string;
    readonly claimKey?: string;
    readonly kind?: MemoryEntry['kind'];
    readonly hardwareScope?: HardwareMemoryScope;
    readonly supersedes?: readonly string[];
  } = {},
): MemoryEntry {
  const ev = fixture.evidence[0]!;
  return makeEntry({
    id: overrides.id ?? 'entry.hw.fact',
    claimKey: overrides.claimKey ?? 'claim.hw.tma',
    claim: 'Verified hardware kernel behavior.',
    kind: overrides.kind ?? 'fact',
    scope: {
      taskpack: 'demo',
      repository: 'org/repo',
      paths: ['src/**'],
      targetMatrix: null,
      ...(overrides.hardwareScope === undefined ? {} : { hardwareScope: overrides.hardwareScope }),
    },
    sourceRef: {
      runId: fixture.lock.spec.runId,
      lockHash: fixture.lock.spec.lockHash,
      candidateDigest: fixture.result.spec.subject.candidateDigest,
    },
    supersedes: overrides.supersedes ?? [],
    evidenceRefs: [
      {
        evidenceId: ev.metadata.id,
        checkId: ev.spec.checkId,
        level: ev.spec.level,
        observedStatus: ev.spec.observedStatus,
        artifact: ev.spec.artifacts[0]!,
      },
    ],
  });
}

describe('hardwareScope schema validation and v1 digest parity', () => {
  it('omits hardwareScope when undefined so v1 canonical JSON, storeDigest, and proposalDigest remain byte-for-byte identical', () => {
    const legacyRaw = {
      version: 1,
      id: 'entry.legacy',
      claimKey: 'claim.legacy',
      claim: 'Legacy v1 claim.',
      kind: 'fact',
      scope: { taskpack: 'demo', repository: 'org/repo', paths: ['src/**'], targetMatrix: null },
      sourceRef: { runId: 'run.one', lockHash: digestOf('lock'), candidateDigest: digestOf('cand') },
      sourceDigest: digestOf('src'),
      verifiedAtMs: 1000,
      validFor: {
        baseRevision: BASE_REVISION,
        sourceRevision: SOURCE_REVISION,
        codeFingerprint: digestOf('fp'),
        upstreamVersions: { npm: '1.0.0' },
      },
      expiresAtMs: 2000,
      supersedes: [],
      evidenceRefs: [
        {
          evidenceId: 'ev.one',
          checkId: 'check.one',
          level: 'local_execution',
          observedStatus: 'passed',
          artifact: { name: 'artifacts/ev.json', digest: digestOf('art'), byteLength: 12 },
        },
      ],
    };

    const parsed = memoryEntrySchema(legacyRaw, '/entry');
    assert.equal(Object.hasOwn(parsed.scope, 'hardwareScope'), false);
    assert.equal(canonical(parsed), canonical(legacyRaw));

    const parsedWithUndefined = memoryEntrySchema(
      { ...legacyRaw, scope: { ...legacyRaw.scope, hardwareScope: undefined } },
      '/entry',
    );
    assert.equal(Object.hasOwn(parsedWithUndefined.scope, 'hardwareScope'), false);
    assert.equal(canonical(parsedWithUndefined), canonical(legacyRaw));

    const legacyStoreBase = {
      version: 1 as const,
      taskpack: 'demo',
      repository: 'org/repo',
      updatedAtMs: 1500,
      entries: [legacyRaw as unknown as MemoryEntry],
      retired: [],
    };
    const parsedStoreBase = { ...legacyStoreBase, entries: [parsed] };
    assert.equal(storeDigestOf(parsedStoreBase).hex, storeDigestOf(legacyStoreBase).hex);

    const legacyProposal = {
      version: 1,
      proposalId: 'proposal.legacy',
      taskpack: 'demo',
      repository: 'org/repo',
      baseRevision: BASE_REVISION,
      baseStoreDigest: storeDigestOf(legacyStoreBase),
      createdAtMs: 1500,
      runId: 'run.one',
      lockHash: digestOf('lock'),
      operations: [{ kind: 'upsert', entry: legacyRaw }],
    };
    const parsedProposal = { ...legacyProposal, operations: [{ kind: 'upsert', entry: parsed }] };
    assert.equal(
      hashDomain('memory-proposal', parsedProposal).hex,
      hashDomain('memory-proposal', legacyProposal).hex,
    );

    const md = renderEntryMarkdown(parsed);
    const reparsed = parseEntryMarkdown(Buffer.from(md, 'utf8'), 'entry.legacy.md');
    assert.equal(canonical(reparsed), canonical(legacyRaw));
  });

  it('round-trips valid hardwareScope and omits undefined optional fields', () => {
    const entry = makeEntry({
      scope: {
        taskpack: 'demo',
        repository: 'org/repo',
        paths: ['src/**'],
        targetMatrix: null,
        hardwareScope: {
          accelerator: 'sm_100a',
          driverConstraint: '>=570.0',
          operatorFamily: 'flash_decode',
          boundPipeline: 'tensor_cube',
        },
      },
    });
    const parsed = memoryEntrySchema(entry, '/entry');
    assert.deepEqual({ ...parsed.scope.hardwareScope }, {
      accelerator: 'sm_100a',
      driverConstraint: '>=570.0',
      operatorFamily: 'flash_decode',
      boundPipeline: 'tensor_cube',
    });
    const md = renderEntryMarkdown(parsed);
    const reparsed = parseEntryMarkdown(Buffer.from(md, 'utf8'), 'entry.alpha.md');
    assert.equal(canonical(reparsed), canonical(parsed));

    const minimal = memoryEntrySchema(
      makeEntry({
        scope: {
          taskpack: 'demo',
          repository: 'org/repo',
          paths: ['src/**'],
          targetMatrix: null,
          hardwareScope: { accelerator: 'ascend_910b', driverConstraint: undefined },
        },
      }),
      '/entry',
    );
    assert.equal(Object.hasOwn(minimal.scope.hardwareScope!, 'driverConstraint'), false);
    assert.equal(Object.hasOwn(minimal.scope.hardwareScope!, 'operatorFamily'), false);
    assert.equal(Object.hasOwn(minimal.scope.hardwareScope!, 'boundPipeline'), false);
    assert.equal(minimal.scope.hardwareScope!.accelerator, 'ascend_910b');
  });

  it('rejects malformed, prototype-polluting, lone-surrogate, unknown-key, and secret-bearing hardwareScope values', () => {
    const base = makeEntry();
    const withRawScope = (hardwareScope: unknown) => ({
      ...base,
      scope: { ...base.scope, hardwareScope },
    });

    // null, non-object, missing/empty/whitespace accelerator
    assert.throws(() => memoryEntrySchema(withRawScope(null)), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope('sm_100a')), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({})), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: '' })), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: '   ' })), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'a'.repeat(65) })), MemoryDiagnosticError);

    // unknown keys and prototype pollution keys
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', extra: 'nope' })), MemoryDiagnosticError);
    const protoPayload = JSON.parse('{"accelerator":"sm_100a","__proto__":{"polluted":true}}') as unknown;
    assert.throws(() => memoryEntrySchema(withRawScope(protoPayload)), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', constructor: 'bad' })), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', prototype: 'bad' })), MemoryDiagnosticError);

    // lone surrogates and non-ASCII / control characters
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_\uD800' })), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', driverConstraint: '>=570\n0' })), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', operatorFamily: 'gemm\u0007' })), MemoryDiagnosticError);
    assert.throws(() => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', boundPipeline: 'tensor_é' })), MemoryDiagnosticError);

    // secret/credential patterns fail closed with MEMORY_SECRET_LEAK
    assert.throws(
      () => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', driverConstraint: 'ghp_1234567890123456789012345' })),
      (error: unknown) => error instanceof MemoryDiagnosticError && error.code === 'MEMORY_SECRET_LEAK',
    );
    assert.throws(
      () => memoryEntrySchema(withRawScope({ accelerator: 'sm_100a', operatorFamily: 'sk-1234567890123456789012345' })),
      (error: unknown) => error instanceof MemoryDiagnosticError && error.code === 'MEMORY_SECRET_LEAK',
    );
  });
});

describe('6th verification gate: hardware-evidence', () => {
  it('admits hardware-scoped fact and invariant backed by passed hardware_execution evidence', () => {
    const fixture = buildHardwareRun({ status: 'completed', level: 'hardware_execution', accelerator: 'sm_100a' });
    const store = makeStore([]);

    for (const kind of ['fact', 'invariant'] as const) {
      const entry = entryBoundToFixture(fixture, {
        id: `entry.hw.${kind}`,
        claimKey: `claim.hw.${kind}`,
        kind,
        hardwareScope: { accelerator: 'sm_100a', driverConstraint: '>=570.0', boundPipeline: 'tensor_cube' },
      });
      const report = verifyMemoryProposal(verifyInputFor(fixture, store, proposalForEntry(fixture, store, entry)));
      assert.equal(report.gates.length, 6);
      assert.equal(report.satisfied, true);
      const hwGate = report.gates.find(g => g.gate === 'hardware-evidence');
      assert.ok(hwGate !== undefined);
      assert.equal(hwGate.status, 'passed');
      assert.deepEqual(hwGate.diagnostics, []);
    }
  });

  it('rejects hardware-scoped fact and invariant lacking passed hardware_execution evidence with MEMORY_HARDWARE_EVIDENCE_REQUIRED', () => {
    const store = makeStore([]);

    for (const level of ['local_execution', 'synthetic_fixture', 'static_inspection'] as const) {
      const fixture = buildHardwareRun({ status: 'completed', level, runId: `run.hw.${level}` });
      for (const kind of ['fact', 'invariant'] as const) {
        const entry = entryBoundToFixture(fixture, {
          id: `entry.${level}.${kind}`,
          claimKey: `claim.${level}.${kind}`,
          kind,
          hardwareScope: { accelerator: 'sm_100a' },
        });
        const report = verifyMemoryProposal(verifyInputFor(fixture, store, proposalForEntry(fixture, store, entry)));
        assert.equal(report.satisfied, false);
        const hwGate = report.gates.find(g => g.gate === 'hardware-evidence');
        assert.ok(hwGate !== undefined);
        assert.equal(hwGate.status, 'failed');
        assert.deepEqual(
          hwGate.diagnostics.map(d => d.code),
          ['MEMORY_HARDWARE_EVIDENCE_REQUIRED'],
        );
      }
    }

    // Failed hardware_execution evidence must also fail closed for fact/invariant
    const failedHwFixture = buildHardwareRun({ status: 'failed', level: 'hardware_execution', runId: 'run.hw.failed' });
    const failedFact = entryBoundToFixture(failedHwFixture, {
      id: 'entry.hw.failed.fact',
      kind: 'fact',
      hardwareScope: { accelerator: 'sm_100a' },
    });
    const failedReport = verifyMemoryProposal(verifyInputFor(failedHwFixture, store, proposalForEntry(failedHwFixture, store, failedFact)));
    assert.equal(failedReport.satisfied, false);
    const failedHwGate = failedReport.gates.find(g => g.gate === 'hardware-evidence');
    assert.ok(failedHwGate !== undefined);
    assert.equal(failedHwGate.status, 'failed');
    assert.deepEqual(
      failedHwGate.diagnostics.map(d => d.code),
      ['MEMORY_HARDWARE_EVIDENCE_REQUIRED'],
    );
  });

  it('admits hardware-scoped failure_observation without requiring a passing hardware_execution ref', () => {
    const failedLocal = buildHardwareRun({ status: 'failed', level: 'local_execution', runId: 'run.hw.trap' });
    const store = makeStore([]);
    const trapEntry = entryBoundToFixture(failedLocal, {
      id: 'entry.hw.trap',
      claimKey: 'claim.hw.trap',
      kind: 'failure_observation',
      hardwareScope: { accelerator: 'ascend_910b', operatorFamily: 'matmul' },
    });
    const report = verifyMemoryProposal(verifyInputFor(failedLocal, store, proposalForEntry(failedLocal, store, trapEntry)));
    assert.equal(report.satisfied, true);
    const hwGate = report.gates.find(g => g.gate === 'hardware-evidence');
    assert.ok(hwGate !== undefined);
    assert.equal(hwGate.status, 'passed');
  });

  it('allows disjoint hardwareScope entries with the same claimKey without conflict in memory-review', () => {
    const fixture = buildHardwareRun({ status: 'completed', level: 'hardware_execution', accelerator: 'sm_89' });
    const existingSm100a = entryBoundToFixture(fixture, {
      id: 'entry.sm100a',
      claimKey: 'claim.shared.tile',
      kind: 'fact',
      hardwareScope: { accelerator: 'sm_100a' },
    });
    const store = makeStore([existingSm100a]);
    const newSm89 = entryBoundToFixture(fixture, {
      id: 'entry.sm89',
      claimKey: 'claim.shared.tile',
      kind: 'fact',
      hardwareScope: { accelerator: 'sm_89' },
    });
    const report = verifyMemoryProposal(verifyInputFor(fixture, store, proposalForEntry(fixture, store, newSm89)));
    assert.equal(report.satisfied, true);
  });
});

describe('active memory selector hardwareScope filtering', () => {
  const contract = makeContract();

  function hwEntry(
    id: string,
    hardwareScope: HardwareMemoryScope | undefined,
    overrides: Partial<MemoryEntry> = {},
  ): MemoryEntry {
    return makeEntry({
      id,
      claimKey: `claim.${id}`,
      scope: {
        taskpack: 'demo',
        repository: 'org/repo',
        paths: ['src/**'],
        targetMatrix: null,
        ...(hardwareScope === undefined ? {} : { hardwareScope }),
      },
      evidenceRefs: [
        {
          evidenceId: `ev.${id}`,
          checkId: 'check.bench',
          level: hardwareScope === undefined ? 'local_execution' : 'hardware_execution',
          observedStatus: 'passed',
          artifact: { name: `artifacts/${id}.json`, digest: hex(id), byteLength: 10 },
        },
      ],
      ...overrides,
    });
  }

  it('isolates sm_100a, sm_89, and ascend_910b entries while keeping unscoped entries eligible everywhere', () => {
    const unscoped = hwEntry('entry.unscoped', undefined);
    const sm100a = hwEntry('entry.sm100a', { accelerator: 'sm_100a' });
    const sm89 = hwEntry('entry.sm89', { accelerator: 'sm_89' });
    const ascend = hwEntry('entry.ascend', { accelerator: 'ascend_910b' });
    const store = makeStore([unscoped, sm100a, sm89, ascend]);

    // Target sm_89: admits unscoped + sm_89; excludes sm_100a + ascend_910b
    const forSm89 = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      currentCodeFingerprint: hex('fingerprint'),
      currentUpstreamVersions: { npm: '1.0.0' },
      targetCell: null,
      hardwareScope: { accelerator: 'sm_89' },
    });
    assert.deepEqual(forSm89.activeEntries.map(e => e.id), ['entry.sm89', 'entry.unscoped']);
    assert.deepEqual(
      forSm89.excludedEntries.map(e => [e.entryId, e.reason]),
      [
        ['entry.ascend', 'scope_mismatch'],
        ['entry.sm100a', 'scope_mismatch'],
      ],
    );

    // Target ascend_910b: admits unscoped + ascend_910b
    const forAscend = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      currentCodeFingerprint: hex('fingerprint'),
      currentUpstreamVersions: { npm: '1.0.0' },
      targetCell: null,
      hardwareScope: { accelerator: 'ascend_910b' },
    });
    assert.deepEqual(forAscend.activeEntries.map(e => e.id), ['entry.ascend', 'entry.unscoped']);

    // Omitting hardwareScope fails closed: excludes all hardware-scoped entries, keeps unscoped
    const forUnscopedRun = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      currentCodeFingerprint: hex('fingerprint'),
      currentUpstreamVersions: { npm: '1.0.0' },
      targetCell: null,
    });
    assert.deepEqual(forUnscopedRun.activeEntries.map(e => e.id), ['entry.unscoped']);
    assert.deepEqual(
      forUnscopedRun.excludedEntries.map(e => [e.entryId, e.reason]),
      [
        ['entry.ascend', 'scope_mismatch'],
        ['entry.sm100a', 'scope_mismatch'],
        ['entry.sm89', 'scope_mismatch'],
      ],
    );
  });

  it('enforces driverConstraint fail-closed and optional operatorFamily/boundPipeline matching', () => {
    const driverPinned = hwEntry('entry.driver.pinned', {
      accelerator: 'sm_100a',
      driverConstraint: '>=570.0',
    });
    const driverAgnostic = hwEntry('entry.driver.any', {
      accelerator: 'sm_100a',
    });
    const gemmTensor = hwEntry('entry.gemm.tensor', {
      accelerator: 'sm_100a',
      operatorFamily: 'gemm',
      boundPipeline: 'tensor_cube',
    });
    const attnHbm = hwEntry('entry.attn.hbm', {
      accelerator: 'sm_100a',
      operatorFamily: 'attention',
      boundPipeline: 'hbm',
    });
    const store = makeStore([driverPinned, driverAgnostic, gemmTensor, attnHbm]);

    // Target omits driverConstraint: driverPinned must be excluded fail-closed!
    const noDriverTarget = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      targetCell: null,
      hardwareScope: { accelerator: 'sm_100a' },
    });
    assert.deepEqual(noDriverTarget.activeEntries.map(e => e.id), [
      'entry.attn.hbm',
      'entry.driver.any',
      'entry.gemm.tensor',
    ]);
    assert.deepEqual(
      noDriverTarget.excludedEntries.map(e => [e.entryId, e.reason]),
      [['entry.driver.pinned', 'scope_mismatch']],
    );

    // Target has mismatched driverConstraint: driverPinned excluded
    const wrongDriver = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      targetCell: null,
      hardwareScope: { accelerator: 'sm_100a', driverConstraint: '>=550.0' },
    });
    assert.equal(wrongDriver.activeEntries.some(e => e.id === 'entry.driver.pinned'), false);

    // Target matches driverConstraint + operatorFamily + boundPipeline
    const exactMatch = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      targetCell: null,
      hardwareScope: {
        accelerator: 'sm_100a',
        driverConstraint: '>=570.0',
        operatorFamily: 'gemm',
        boundPipeline: 'tensor_cube',
      },
    });
    assert.deepEqual(exactMatch.activeEntries.map(e => e.id), [
      'entry.driver.any',
      'entry.driver.pinned',
      'entry.gemm.tensor',
    ]);
    assert.deepEqual(
      exactMatch.excludedEntries.map(e => [e.entryId, e.reason]),
      [['entry.attn.hbm', 'scope_mismatch']],
    );
  });

  it('excludes hardware-scoped facts lacking hardware_execution evidence while admitting hardware-scoped failure_observation', () => {
    const unprovenFact = hwEntry('entry.unproven.fact', { accelerator: 'sm_100a' }, {
      kind: 'fact',
      evidenceRefs: [
        {
          evidenceId: 'ev.local',
          checkId: 'check.bench',
          level: 'local_execution',
          observedStatus: 'passed',
          artifact: { name: 'artifacts/local.json', digest: hex('local'), byteLength: 10 },
        },
      ],
    });
    const trapFailure = hwEntry('entry.trap.fail', { accelerator: 'sm_100a' }, {
      kind: 'failure_observation',
      evidenceRefs: [
        {
          evidenceId: 'ev.fail',
          checkId: 'check.bench',
          level: 'local_execution',
          observedStatus: 'failed',
          artifact: { name: 'artifacts/fail.json', digest: hex('fail'), byteLength: 10 },
        },
      ],
    });
    const store = makeStore([unprovenFact, trapFailure]);

    const snap = selectActiveMemory({
      store,
      contract,
      nowMs: 1500,
      targetCell: null,
      hardwareScope: { accelerator: 'sm_100a' },
    });
    assert.deepEqual(snap.activeEntries.map(e => e.id), ['entry.trap.fail']);
    assert.deepEqual(
      snap.excludedEntries.map(e => [e.entryId, e.reason]),
      [['entry.unproven.fact', 'hardware_or_gate_unproven']],
    );
  });
});

describe('finalizer hardwareScope gating integration', () => {
  function buildMixedHardwareRun(options: {
    readonly runId: string;
    readonly status: 'completed' | 'failed';
    readonly accelerator: string;
  }): RunFixture {
    const contract: TaskContract = {
      ...makeContract(['hardware_execution'], options.accelerator),
      spec: {
        ...makeContract(['hardware_execution'], options.accelerator).spec,
        acceptance: {
          required: ['evolve-block-guard.v1', 'benchmark-gate.v1'],
          checks: [
            { id: 'evolve-block-guard.v1', allowedEvidenceLevels: ['local_execution'] },
            { id: 'benchmark-gate.v1', allowedEvidenceLevels: ['hardware_execution'], targetCellId: 'cuda-b200' },
          ],
        },
      },
    };
    const admitted = admitTask(contract, { admissionId: `admission.${options.runId}`, runId: options.runId });
    if (!admitted.ok) throw new Error(JSON.stringify(admitted.errors));
    const lock = admitted.value;
    const candidate = artifactOf('candidate.bin', `candidate-${options.runId}`);
    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: [refOf(candidate)] },
    };
    const bound = bindSubject(lock, manifest);
    if (!bound.ok) throw new Error(JSON.stringify(bound.errors));
    const subject = bound.value;

    const passed = options.status === 'completed';
    const observedStatus = passed ? 'passed' : 'failed';
    const localArtifact = artifactOf('evidence-guard.bin', `guard-${options.runId}-${options.status}`);
    const hwArtifact = artifactOf('evidence-bench.bin', `bench-${options.runId}-${options.status}`);

    const localEvidence: Evidence = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Evidence',
      metadata: { id: 'evidence.evolve-block-guard.v1' },
      spec: {
        checkId: 'evolve-block-guard.v1',
        observedStatus,
        producerId: 'producer.guard',
        method: 'evolve-block-guard',
        level: 'local_execution',
        subject: structuredClone(subject),
        artifacts: [refOf(localArtifact)],
        reason: passed ? null : 'guard violation',
      },
    };
    const hwEvidence: Evidence = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Evidence',
      metadata: { id: 'evidence.benchmark-gate.v1' },
      spec: {
        checkId: 'benchmark-gate.v1',
        observedStatus,
        producerId: 'producer.hw',
        method: 'benchmark-gate',
        level: 'hardware_execution',
        subject: structuredClone(subject),
        artifacts: [refOf(hwArtifact)],
        reason: passed ? null : 'benchmark regression',
        hardwareProvenance: {
          targetCellId: 'cuda-b200',
          probeKind: 'physical',
          vendor: 'nvidia',
          deviceModel: 'B200',
          accelerator: options.accelerator,
          isolationMode: 'whole_device',
          deviceCount: 1,
          driverVersion: '570.124.06',
          runtimeVersion: 'cuda-12.8',
          workloadDigest: hex('workload'),
          clockLockMode: 'locked',
        },
      },
    };
    const claims = [
      {
        checkId: 'evolve-block-guard.v1',
        status: observedStatus as 'passed' | 'failed',
        evidenceId: localEvidence.metadata.id,
        reason: passed ? null : 'guard violation',
      },
      {
        checkId: 'benchmark-gate.v1',
        status: observedStatus as 'passed' | 'failed',
        evidenceId: hwEvidence.metadata.id,
        reason: passed ? null : 'benchmark regression',
      },
    ];
    const built = constructRunResult(
      {
        trusted: {
          expectedLock: lock,
          candidateManifest: manifest,
          eligibleEvidence: [localEvidence, hwEvidence],
          usage: [],
          externalEffects: 'none',
          noChange: null,
        },
        candidate: { status: options.status, checks: claims, memory: { status: 'not_requested', reason: null } },
      },
      [candidate, localArtifact, hwArtifact],
    );
    if (!built.ok) throw new Error(JSON.stringify(built.errors));
    return {
      lock,
      result: built.value,
      evidence: [localEvidence, hwEvidence],
      manifest,
      artifactRefs: [refOf(candidate), refOf(localArtifact), refOf(hwArtifact)],
    };
  }

  it('omits hardwareScope on local_execution facts, retains it on hardware_execution facts and failure_observations, and passes verify + CAS', async () => {
    const hardwareScope: HardwareMemoryScope = {
      accelerator: 'sm_100a',
      driverConstraint: '>=570.0',
      operatorFamily: 'gemm',
      boundPipeline: 'tensor_cube',
    };
    const ledger: MemoryBudgetLedger = {
      revision: 1,
      remainingTokens: 1000,
      remainingModelCalls: 5,
      remainingWallMs: 60000,
    };
    const makeConfig = (nowMs: number): MemoryFinalizerConfig => ({
      taskpack: 'demo',
      memoryWritable: [memoryDirectoryFor('demo')],
      onNoModelBudget: 'deterministic-observations-only',
      nowMs,
      ttlMs: 86_400_000,
      upstreamVersions: { npm: '1.0.0' },
      hardwareScope,
    });

    const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-hw-finalizer-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'kernel.cu'), '// kernel', { mode: 0o600 });

      // 1. Failed hardware run: failure_observation entries retain hardwareScope (even for local_execution checks)
      const failedRun = buildMixedHardwareRun({ runId: 'run.hw.fail', status: 'failed', accelerator: 'sm_100a' });
      const failedOutcome = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: root,
          summary: {
            lock: failedRun.lock,
            result: failedRun.result,
            incident: null,
            observations: [],
            evidence: failedRun.evidence,
            ledger,
            candidateManifest: failedRun.manifest.spec.entries,
            artifacts: failedRun.artifactRefs,
          },
        },
        config: makeConfig(1000),
      });
      assert.equal(failedOutcome.status, 'proposed');
      assert.ok(failedOutcome.proposal !== null);
      assert.equal(failedOutcome.deterministicEntries.length, 2);
      for (const entry of failedOutcome.deterministicEntries) {
        assert.equal(entry.kind, 'failure_observation');
        assert.deepEqual({ ...entry.scope.hardwareScope }, hardwareScope);
      }

      const emptyStore = (await loadMemoryStore(root, 'demo', 'org/repo')).index;
      const failedReport = verifyMemoryProposal({
        proposal: failedOutcome.proposal,
        store: emptyStore,
        lock: failedRun.lock,
        result: failedRun.result,
        incident: null,
        evidence: failedRun.evidence,
        artifacts: inventoryMap(failedRun),
        candidateDigest: failedRun.result.spec.subject.candidateDigest,
        patch: failedOutcome.patch ?? '',
        secretValues: [],
        memoryWritable: [memoryDirectoryFor('demo')],
        protectedPaths: [],
      });
      assert.equal(failedReport.satisfied, true);
      assert.deepEqual(failedReport.gates.flatMap(g => g.diagnostics), []);

      const failedCas = await applyMemoryProposalCAS({
        repository: root,
        taskpack: 'demo',
        proposal: failedOutcome.proposal,
        lock: failedRun.lock,
        result: failedRun.result,
        incident: null,
        evidence: failedRun.evidence,
        artifacts: inventoryMap(failedRun),
        candidateDigest: failedRun.result.spec.subject.candidateDigest,
        secretValues: [],
        memoryWritable: [memoryDirectoryFor('demo')],
        protectedPaths: [],
        targetBranch: 'main',
        currentRevision: BASE_REVISION,
        baseStore: emptyStore,
        allowRebase: true,
        nowMs: 1000,
      });
      assert.equal(failedCas.applied, true);

      // 2. Completed hardware run with passing local_execution + passing hardware_execution checks
      const completedRun = buildMixedHardwareRun({ runId: 'run.hw.pass', status: 'completed', accelerator: 'sm_100a' });
      const completedOutcome = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: root,
          summary: {
            lock: completedRun.lock,
            result: completedRun.result,
            incident: null,
            observations: [],
            evidence: completedRun.evidence,
            ledger,
            candidateManifest: completedRun.manifest.spec.entries,
            artifacts: completedRun.artifactRefs,
          },
        },
        config: makeConfig(2000),
      });
      assert.equal(completedOutcome.status, 'proposed');
      assert.ok(completedOutcome.proposal !== null);
      assert.equal(completedOutcome.deterministicEntries.length, 2);

      const localFact = completedOutcome.deterministicEntries.find(e => e.claimKey === 'claim.check.evolve-block-guard.v1');
      const hwFact = completedOutcome.deterministicEntries.find(e => e.claimKey === 'claim.check.benchmark-gate.v1');
      assert.ok(localFact !== undefined);
      assert.ok(hwFact !== undefined);
      assert.equal(localFact.kind, 'fact');
      assert.equal(hwFact.kind, 'fact');
      assert.equal(Object.hasOwn(localFact.scope, 'hardwareScope'), false);
      assert.deepEqual({ ...hwFact.scope.hardwareScope }, hardwareScope);
      assert.equal(localFact.supersedes.length, 1);
      assert.equal(hwFact.supersedes.length, 1);

      const storeBeforePass = (await loadMemoryStore(root, 'demo', 'org/repo')).index;
      const completedReport = verifyMemoryProposal({
        proposal: completedOutcome.proposal,
        store: storeBeforePass,
        lock: completedRun.lock,
        result: completedRun.result,
        incident: null,
        evidence: completedRun.evidence,
        artifacts: inventoryMap(completedRun),
        candidateDigest: completedRun.result.spec.subject.candidateDigest,
        patch: completedOutcome.patch ?? '',
        secretValues: [],
        memoryWritable: [memoryDirectoryFor('demo')],
        protectedPaths: [],
      });
      assert.equal(completedReport.gates.length, 6);
      assert.equal(completedReport.satisfied, true);
      assert.deepEqual(completedReport.gates.flatMap(g => g.diagnostics), []);

      const completedCas = await applyMemoryProposalCAS({
        repository: root,
        taskpack: 'demo',
        proposal: completedOutcome.proposal,
        lock: completedRun.lock,
        result: completedRun.result,
        incident: null,
        evidence: completedRun.evidence,
        artifacts: inventoryMap(completedRun),
        candidateDigest: completedRun.result.spec.subject.candidateDigest,
        secretValues: [],
        memoryWritable: [memoryDirectoryFor('demo')],
        protectedPaths: [],
        targetBranch: 'main',
        currentRevision: BASE_REVISION,
        baseStore: storeBeforePass,
        allowRebase: true,
        nowMs: 2000,
      });
      assert.equal(completedCas.applied, true);

      const finalStore = (await loadMemoryStore(root, 'demo', 'org/repo')).index;
      assert.equal(finalStore.entries.length, 2);
      const persistedLocal = finalStore.entries.find(e => e.claimKey === 'claim.check.evolve-block-guard.v1');
      const persistedHw = finalStore.entries.find(e => e.claimKey === 'claim.check.benchmark-gate.v1');
      assert.ok(persistedLocal !== undefined && Object.hasOwn(persistedLocal.scope, 'hardwareScope') === false);
      assert.ok(persistedHw !== undefined && persistedHw.scope.hardwareScope?.accelerator === 'sm_100a');

      // 3. A local_execution pass on gfx942 must NOT silently widen and clobber sm_100a's hardware-scoped benchmark fact
      const gfxScope: HardwareMemoryScope = { accelerator: 'gfx942', driverConstraint: '>=6.2.0' };
      const gfxRun = buildMixedHardwareRun({ runId: 'run.gfx.pass', status: 'completed', accelerator: 'gfx942' });
      const gfxLocalOnlyEvidence = gfxRun.evidence.map(ev =>
        ev.spec.checkId === 'benchmark-gate.v1'
          ? { ...ev, spec: { ...ev.spec, level: 'local_execution' as const } }
          : ev,
      );
      const gfxOutcome = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: root,
          summary: {
            lock: gfxRun.lock,
            result: gfxRun.result,
            incident: null,
            observations: [],
            evidence: gfxLocalOnlyEvidence,
            ledger,
            candidateManifest: gfxRun.manifest.spec.entries,
            artifacts: gfxRun.artifactRefs,
          },
        },
        config: { ...makeConfig(3000), hardwareScope: gfxScope },
      });
      assert.equal(
        gfxOutcome.deterministicEntries.some(e => e.claimKey === 'claim.check.benchmark-gate.v1'),
        false,
        'local_execution pass on gfx942 must not emit hardware-universal fact clobbering sm_100a entry',
      );
      assert.match(gfxOutcome.reason ?? '', /hardware_evidence_required_skipped:1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
