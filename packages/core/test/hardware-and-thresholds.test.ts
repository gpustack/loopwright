import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitTask,
  bindSubject,
  constructRunResult,
  digestArtifact,
  digestArtifactFromMetadata,
  evaluateAcceptance,
  identifyManifest,
  isVerifierNamespacePath,
  isWritablePath,
  matchesDriverConstraint,
  matchesHardwareTarget,
  parseVerifierArtifactPath,
  resolveInventory,
  validateDocument,
  validateRelativePath,
  DIAGNOSTIC_CODES,
  LIMITS,
  OVERLAY_LIMITS,
  VERIFIER_ARTIFACT_LIMITS,
  type Digest,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type MetricThresholdRule,
  type ResolvedArtifactInput,
} from '../src/index.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

const ADMISSION = { admissionId: 'admission-1', runId: 'run-1' };
const WORKLOAD_DIGEST: Digest = { algorithm: 'sha256', hex: 'd'.repeat(64) };

function makeHardwareContract(options?: {
  readonly hardware?: HardwareTargetSpec;
  readonly allowSyntheticHardwareProbe?: boolean;
  readonly metricThresholds?: readonly MetricThresholdRule[];
}) {
  const task = contract();
  const hardware: HardwareTargetSpec = options?.hardware ?? {
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 1,
    driverConstraint: '>=550.54.15',
    topology: 'nvlink-8x',
  };
  Object.assign(task.spec.target, {
    matrix: [{
      id: 'h100-sm90',
      platform: 'linux',
      variant: 'cuda',
      hardware,
    }],
  });
  Object.assign(task.spec.acceptance.checks[0]!, {
    allowedEvidenceLevels: ['hardware_execution'],
    targetCellId: 'h100-sm90',
    ...(options?.allowSyntheticHardwareProbe !== undefined
      ? { allowSyntheticHardwareProbe: options.allowSyntheticHardwareProbe }
      : {}),
    ...(options?.metricThresholds !== undefined
      ? { metricThresholds: options.metricThresholds }
      : {}),
  });
  return task;
}

function makeProvenance(overrides?: Partial<HardwareProvenance>): HardwareProvenance {
  return {
    targetCellId: 'h100-sm90',
    probeKind: 'physical',
    vendor: 'NVIDIA',
    deviceModel: 'NVIDIA H100 80GB HBM3',
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 1,
    driverVersion: '550.54.15',
    runtimeVersion: 'cuda-12.4',
    topology: 'nvlink-8x',
    workloadDigest: { ...WORKLOAD_DIGEST },
    clockLockMode: 'locked',
    ...overrides,
  };
}

function makeHardwareEvaluation(options?: {
  readonly hardware?: HardwareTargetSpec;
  readonly allowSyntheticHardwareProbe?: boolean;
  readonly metricThresholds?: readonly MetricThresholdRule[];
  readonly provenance?: Partial<HardwareProvenance>;
  readonly metrics?: Record<string, number | string | boolean>;
}) {
  const task = makeHardwareContract({
    ...(options?.hardware ? { hardware: options.hardware } : {}),
    ...(options?.allowSyntheticHardwareProbe !== undefined
      ? { allowSyntheticHardwareProbe: options.allowSyntheticHardwareProbe }
      : {}),
    ...(options?.metricThresholds ? { metricThresholds: options.metricThresholds } : {}),
  });
  const fixture = evaluationFixture(task);
  const provenance = makeProvenance(options?.provenance);
  Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, {
    level: 'hardware_execution',
    hardwareProvenance: provenance,
    ...(options?.metrics !== undefined ? { metrics: options.metrics } : {}),
  });
  return { ...fixture, provenance };
}

test('legacy target.matrix and check fixtures keep bit-for-bit identical canonical hashes and omit optional keys', () => {
  const legacyTask = contract();
  legacyTask.spec.target.matrix = [{ id: 'linux-cpu', platform: 'linux', variant: 'cpu' }];
  const lock = value(admitTask(legacyTask, ADMISSION));

  const cell = lock.spec.contract.spec.target.matrix![0]!;
  const check = lock.spec.contract.spec.acceptance.checks[0]!;
  assert.equal(Object.hasOwn(cell, 'hardware'), false);
  assert.equal(Object.hasOwn(check, 'targetCellId'), false);
  assert.equal(Object.hasOwn(check, 'allowSyntheticHardwareProbe'), false);
  assert.equal(Object.hasOwn(check, 'metricThresholds'), false);

  const manifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [] },
  };
  const subject = value(bindSubject(lock, manifest));
  // Pinned pre-T2 canonical SHA-256 digests for the legacy fixture
  assert.equal(subject.targetMatrixDigest?.hex, '1d2802e779c4a067de12bfec53199680494300e806fd2fb1f3caf8efe2f58920');
  assert.equal(lock.spec.contractHash.hex, '585f89bc3bee800acb366ccf5d081e4ed7ca45540251a66e7994d8ce7cd5c501');
  assert.equal(lock.spec.lockHash.hex, '1ce06cf357d62ee441772601c5103ea05890ded19e726c4b922fc350fff9684c');
  // Pre-T2 serialized TaskLock round-trips cleanly through current validator
  const roundTrippedLock = value(validateDocument(JSON.parse(JSON.stringify(lock)) as unknown, 'TaskLock'));
  assert.equal(roundTrippedLock.spec.lockHash.hex, '1ce06cf357d62ee441772601c5103ea05890ded19e726c4b922fc350fff9684c');

  // Adding hardware metadata changes targetMatrixDigest, contractHash, and lockHash
  const hwTask = makeHardwareContract({
    hardware: { accelerator: 'sm_90a', isolationMode: 'whole_device' },
  });
  const hwLock = value(admitTask(hwTask, ADMISSION));
  const hwCell = hwLock.spec.contract.spec.target.matrix![0]!;
  assert.equal(Object.getPrototypeOf(hwCell.hardware), null);
  assert.equal(Object.hasOwn(hwCell.hardware!, 'deviceCount'), false);
  assert.equal(Object.hasOwn(hwCell.hardware!, 'driverConstraint'), false);
  assert.equal(Object.hasOwn(hwCell.hardware!, 'topology'), false);
  assert.notEqual(hwLock.spec.contractHash.hex, lock.spec.contractHash.hex);
  assert.notEqual(hwLock.spec.lockHash.hex, lock.spec.lockHash.hex);
});

test('hardware target.matrix cells validate accelerator, isolationMode, deviceCount, driverConstraint, and topology', () => {
  const withHardware = (hardware: unknown) => {
    const task = contract();
    Object.assign(task.spec.target, {
      matrix: [{ id: 'gpu-0', platform: 'linux', variant: 'cuda', hardware }],
    });
    return validateDocument(task, 'TaskContract');
  };

  // Valid minimal and full hardware cells
  assert.equal(withHardware({ accelerator: 'sm_89', isolationMode: 'whole_device' }).ok, true);
  assert.equal(withHardware({ accelerator: 'gfx1101', isolationMode: 'sliced', deviceCount: 1 }).ok, true);
  assert.equal(withHardware({
    accelerator: 'ascend_910b',
    isolationMode: 'whole_device',
    deviceCount: 64,
    driverConstraint: '>=6.2',
    topology: 'hccs-8x',
  }).ok, true);
  assert.equal(withHardware({
    accelerator: 'sm_100a',
    isolationMode: 'whole_device',
    driverConstraint: '550.54.15',
  }).ok, true);
  assert.equal(withHardware({
    accelerator: 'sm_100a',
    isolationMode: 'whole_device',
    driverConstraint: 'Driver 1.0',
  }).ok, true);

  // Invalid accelerator
  for (const badAcc of ['', ' sm_90a', 'sm_90a ', 'sm\n90a', 'sm\t90a', 'sm\u202E90a', 'a'.repeat(65)]) {
    assert.equal(code(withHardware({ accelerator: badAcc, isolationMode: 'whole_device' })), 'VALUE_RANGE', badAcc);
  }
  assert.equal(code(withHardware({ accelerator: 'sm_\uD800', isolationMode: 'whole_device' })), 'INPUT_UNSUPPORTED');

  // Invalid isolationMode
  assert.equal(code(withHardware({ accelerator: 'sm_90a', isolationMode: 'shared' })), 'VALUE_ENUM');

  // Invalid deviceCount
  for (const badCount of [0, -1, 65, 1.5, NaN]) {
    assert.equal(code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', deviceCount: badCount })), 'VALUE_RANGE', String(badCount));
  }

  // Invalid driverConstraint
  for (const badDriver of ['', '>=', '>=abc', '>=1..2', '>=.1', '>=1.', '>= 550.54', '>=99999999999999999999999', '550\t54', '550\n54', ' 550.54', '550.54 ', 'd'.repeat(129)]) {
    assert.equal(code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', driverConstraint: badDriver })), 'VALUE_RANGE', badDriver);
  }

  // Invalid topology
  for (const badTopo of ['', ' nvlink', 'nvlink ', 'nv\nlink', 'nv\u200Blink', 't'.repeat(129)]) {
    assert.equal(code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', topology: badTopo })), 'VALUE_RANGE', badTopo);
  }

  // Unknown key rejected
  assert.equal(code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', extra: true })), 'FIELD_UNKNOWN');
});

test('TaskContract enforces unmixed hardware_execution checks and valid targetCellId bindings', () => {
  // Valid unmixed hardware_execution check with hardware cell
  assert.equal(validateDocument(makeHardwareContract(), 'TaskContract').ok, true);

  // Mixed allowedEvidenceLevels with hardware_execution -> VALUE_RANGE
  const mixed = makeHardwareContract();
  mixed.spec.acceptance.checks[0]!.allowedEvidenceLevels = ['hardware_execution', 'local_execution'];
  assert.equal(code(validateDocument(mixed, 'TaskContract')), 'VALUE_RANGE');

  // hardware_execution without targetCellId -> FIELD_REQUIRED
  const missingCellId = makeHardwareContract();
  Reflect.deleteProperty(missingCellId.spec.acceptance.checks[0]!, 'targetCellId');
  assert.equal(code(validateDocument(missingCellId, 'TaskContract')), 'FIELD_REQUIRED');

  // hardware_execution pointing to a target.matrix cell WITHOUT hardware -> REFERENCE_UNKNOWN
  const cpuCellTask = contract();
  cpuCellTask.spec.target.matrix = [{ id: 'linux-cpu', platform: 'linux', variant: 'cpu' }];
  Object.assign(cpuCellTask.spec.acceptance.checks[0]!, {
    allowedEvidenceLevels: ['hardware_execution'],
    targetCellId: 'linux-cpu',
  });
  assert.equal(code(validateDocument(cpuCellTask, 'TaskContract')), 'REFERENCE_UNKNOWN');

  // Any check with unknown targetCellId -> REFERENCE_UNKNOWN
  const unknownCell = contract();
  unknownCell.spec.target.matrix = [{ id: 'linux-cpu', platform: 'linux', variant: 'cpu' }];
  Object.assign(unknownCell.spec.acceptance.checks[0]!, { targetCellId: 'missing-cell' });
  assert.equal(code(validateDocument(unknownCell, 'TaskContract')), 'REFERENCE_UNKNOWN');

  // Non-hardware check with valid non-hardware targetCellId -> allowed
  const validCpuBinding = contract();
  validCpuBinding.spec.target.matrix = [{ id: 'linux-cpu', platform: 'linux', variant: 'cpu' }];
  Object.assign(validCpuBinding.spec.acceptance.checks[0]!, { targetCellId: 'linux-cpu' });
  assert.equal(validateDocument(validCpuBinding, 'TaskContract').ok, true);

  // allowSyntheticHardwareProbe type check
  const badProbe = makeHardwareContract();
  Object.assign(badProbe.spec.acceptance.checks[0]!, { allowSyntheticHardwareProbe: 'yes' });
  assert.equal(code(validateDocument(badProbe, 'TaskContract')), 'VALUE_TYPE');
});

test('metricThresholds schema validates bounds, comparative rules, -0 normalization, and 0..32 cap', () => {
  const withThresholds = (metricThresholds: unknown) => {
    const task = contract();
    Object.assign(task.spec.acceptance.checks[0]!, { metricThresholds });
    return validateDocument(task, 'TaskContract');
  };

  // Empty array and 32 rules succeed; 33 fails
  assert.equal(withThresholds([]).ok, true);
  const rules32 = Array.from({ length: LIMITS.metricThresholds }, (_, i) => ({
    kind: 'bounds' as const,
    metric: `metric_${i}`,
    min: 0,
    max: 100,
  }));
  assert.equal(withThresholds(rules32).ok, true);
  assert.equal(code(withThresholds([...rules32, { kind: 'bounds', metric: 'extra', min: 0 }])), 'VALUE_RANGE');

  // -0 normalized to 0 in bounds and comparative rules
  const negZero = value(withThresholds([
    { kind: 'bounds', metric: 'delta', min: -0, max: -0 },
    { kind: 'comparative', metric: 'lat', baselineMetric: 'base_lat', operator: 'max_delta', threshold: -0 },
    { kind: 'comparative', metric: 'tflops', baselineMetric: 'base_tflops', operator: 'min_ratio', threshold: -0 },
    { kind: 'comparative', metric: 'err', baselineMetric: 'base_err', operator: 'max_delta', threshold: -5.5 },
  ]));
  const parsedRules = negZero.spec.acceptance.checks[0]!.metricThresholds!;
  assert.equal(parsedRules[0]!.kind, 'bounds');
  if (parsedRules[0]!.kind === 'bounds') {
    assert.equal(Object.is(parsedRules[0]!.min, 0), true);
    assert.equal(Object.is(parsedRules[0]!.max, 0), true);
  }
  assert.equal(parsedRules[1]!.kind, 'comparative');
  if (parsedRules[1]!.kind === 'comparative') {
    assert.equal(Object.is(parsedRules[1]!.threshold, 0), true);
  }

  // Invalid bounds rules
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'lat' }])), 'VALUE_RANGE');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'lat', min: 10, max: 5 }])), 'VALUE_RANGE');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'lat', min: NaN }])), 'VALUE_RANGE');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'lat', max: Infinity }])), 'VALUE_RANGE');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'bad/key', min: 0 }])), 'IDENTIFIER_INVALID');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'constructor', min: 0 }])), 'IDENTIFIER_INVALID');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'lat', min: 0, extra: true }])), 'FIELD_UNKNOWN');

  // Signed finite ratio thresholds are admitted (positive denominator is enforced at evaluation)
  assert.equal(withThresholds([
    { kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: -0.1 },
    { kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: -0.5 },
  ]).ok, true);

  // Invalid comparative rules
  assert.equal(code(withThresholds([{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: NaN }])), 'VALUE_RANGE');
  assert.equal(code(withThresholds([{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: Infinity }])), 'VALUE_RANGE');
  assert.equal(code(withThresholds([{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'equals', threshold: 1 }])), 'VALUE_ENUM');
  assert.equal(code(withThresholds([{ kind: 'comparative', metric: 'a', baselineMetric: '__proto__', operator: 'max_delta', threshold: 1 }])), 'IDENTIFIER_INVALID');
  assert.equal(code(withThresholds([{ metric: 'a', min: 1 }])), 'FIELD_REQUIRED');
  assert.equal(code(withThresholds([{ kind: 'unknown', metric: 'a' }])), 'VALUE_ENUM');
});

test('hardwareProvenance schema validates strict fields and requires provenance on passed hardware_execution', () => {
  const fixture = makeHardwareEvaluation();
  const valid = value(validateDocument(fixture.input.trusted.eligibleEvidence[0], 'Evidence'));
  assert.equal(valid.spec.hardwareProvenance?.accelerator, 'sm_90a');
  assert.equal(Object.getPrototypeOf(valid.spec.hardwareProvenance), null);

  // Optional topology omitted when absent
  const noTopo = makeHardwareEvaluation();
  Reflect.deleteProperty(noTopo.provenance, 'topology');
  const parsedNoTopo = value(validateDocument(noTopo.input.trusted.eligibleEvidence[0], 'Evidence'));
  assert.equal(Object.hasOwn(parsedNoTopo.spec.hardwareProvenance!, 'topology'), false);

  // Missing hardwareProvenance on passed hardware_execution -> FIELD_REQUIRED
  const missingProv = makeHardwareEvaluation();
  Reflect.deleteProperty(missingProv.input.trusted.eligibleEvidence[0]!.spec, 'hardwareProvenance');
  assert.equal(code(validateDocument(missingProv.input.trusted.eligibleEvidence[0], 'Evidence')), 'FIELD_REQUIRED');

  // Missing hardwareProvenance on blocked/failed hardware_execution -> allowed
  const blockedHw = makeHardwareEvaluation();
  Reflect.deleteProperty(blockedHw.input.trusted.eligibleEvidence[0]!.spec, 'hardwareProvenance');
  Object.assign(blockedHw.input.trusted.eligibleEvidence[0]!.spec, {
    observedStatus: 'blocked',
    reason: 'BENCHMARK_PREEMPTED',
  });
  assert.equal(validateDocument(blockedHw.input.trusted.eligibleEvidence[0], 'Evidence').ok, true);

  // Malformed verifier artifact name inside Evidence is rejected with PATH_INVALID
  const badArtifactEv = makeHardwareEvaluation();
  badArtifactEv.input.trusted.eligibleEvidence[0]!.spec.artifacts = [{
    name: '.loopwright-verifier/BadSlot/out.cubin',
    digest: { algorithm: 'sha256', hex: 'e'.repeat(64) },
    byteLength: 16,
  }];
  assert.equal(code(validateDocument(badArtifactEv.input.trusted.eligibleEvidence[0], 'Evidence')), 'PATH_INVALID');

  // Invalid provenance fields rejected
  for (const [patch, expectedCode] of [
    [{ probeKind: 'emulated' }, 'VALUE_ENUM'],
    [{ clockLockMode: 'turbo' }, 'VALUE_ENUM'],
    [{ deviceCount: 0 }, 'VALUE_RANGE'],
    [{ deviceCount: 65 }, 'VALUE_RANGE'],
    [{ driverVersion: '550\t54' }, 'VALUE_RANGE'],
    [{ driverVersion: ' 550.54' }, 'VALUE_RANGE'],
    [{ vendor: ' NVIDIA' }, 'VALUE_RANGE'],
    [{ workloadDigest: { algorithm: 'sha256', hex: 'not-hex' } }, 'VALUE_RANGE'],
    [{ extraField: 1 }, 'FIELD_UNKNOWN'],
  ] as const) {
    const bad = makeHardwareEvaluation();
    Object.assign(bad.provenance, patch);
    assert.equal(code(validateDocument(bad.input.trusted.eligibleEvidence[0], 'Evidence')), expectedCode, JSON.stringify(patch));
  }
});

test('matchesDriverConstraint and matchesHardwareTarget enforce exact and dotted-version semantics', () => {
  assert.equal(matchesDriverConstraint('550.54.15', '550.54.15'), true);
  assert.equal(matchesDriverConstraint('550.54.15', '550.54.16'), false);
  assert.equal(matchesDriverConstraint('>=550.54.15', '550.54.15'), true);
  assert.equal(matchesDriverConstraint('>=550.54.15', '550.54.16'), true);
  assert.equal(matchesDriverConstraint('>=550.54.15', '551.0'), true);
  assert.equal(matchesDriverConstraint('>=550.54.15', '550.54.14'), false);
  assert.equal(matchesDriverConstraint('>=550.54', '550.54.1'), true);
  assert.equal(matchesDriverConstraint('>=550.54.0', '550.54'), true);
  assert.equal(matchesDriverConstraint('>=550.54.1', '550.54'), false);
  assert.equal(matchesDriverConstraint('>=535.104.05', '535.104.05'), true);
  assert.equal(matchesDriverConstraint('>=550.54', '550.54-beta'), false);
  assert.equal(matchesDriverConstraint('>=', '550.54'), false);
  assert.equal(matchesDriverConstraint('', '550.54'), false);
  assert.equal(matchesDriverConstraint('550.54', ''), false);

  const spec: HardwareTargetSpec = {
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 2,
    driverConstraint: '>=550.54.15',
    topology: 'nvlink-2x',
  };
  const good = makeProvenance({ deviceCount: 2, topology: 'nvlink-2x', driverVersion: '550.90.07' });
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, good), true);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, undefined), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, { ...good, probeKind: 'synthetic_fixture' }), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', true, { ...good, probeKind: 'synthetic_fixture' }), true);
  assert.equal(matchesHardwareTarget(spec, 'other-cell', false, good), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, { ...good, accelerator: 'sm_89' }), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, { ...good, isolationMode: 'sliced' }), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, { ...good, deviceCount: 1 }), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, { ...good, topology: 'pcie' }), false);
  assert.equal(matchesHardwareTarget(spec, 'h100-sm90', false, { ...good, driverVersion: '550.54.14' }), false);
});

test('evaluateAcceptance and constructRunResult enforce hardwareProvenance and metricThresholds independently', () => {
  assert.equal(DIAGNOSTIC_CODES.includes('HARDWARE_PROVENANCE_MISMATCH'), true);
  assert.equal(DIAGNOSTIC_CODES.includes('METRIC_THRESHOLD_FAILED'), true);

  const thresholds: readonly MetricThresholdRule[] = [
    { kind: 'bounds', metric: 'max_abs_err', min: 0, max: 1e-4 },
    { kind: 'bounds', metric: 'tflops', min: 400 },
    { kind: 'comparative', metric: 'tflops', baselineMetric: 'baseline_tflops', operator: 'min_ratio', threshold: 1.25 },
    { kind: 'comparative', metric: 'latency_us', baselineMetric: 'baseline_latency_us', operator: 'max_ratio', threshold: 0.8 },
    { kind: 'comparative', metric: 'latency_us', baselineMetric: 'baseline_latency_us', operator: 'max_delta', threshold: -20 },
  ];

  // Exact boundary equality passes and constructs a completed RunResult
  const passing = makeHardwareEvaluation({
    metricThresholds: thresholds,
    metrics: {
      max_abs_err: -0,
      tflops: 400,
      baseline_tflops: 320,
      latency_us: 80,
      baseline_latency_us: 100,
    },
  });
  const evalOk = value(evaluateAcceptance(passing.input, passing.artifacts));
  assert.equal(evalOk.spec.satisfied, true);
  assert.equal(evalOk.spec.required[0]!.status, 'passed');
  assert.equal(validateDocument(evalOk, 'VerificationResult').ok, true);

  const runOk = value(constructRunResult({
    trusted: { ...passing.input.trusted, usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: passing.input.claims, memory: { status: 'not_requested', reason: null } },
  }, passing.artifacts));
  assert.equal(runOk.spec.status, 'completed');
  assert.equal(validateDocument(runOk, 'RunResult').ok, true);

  // Synthetic fixture blocked by default, allowed when allowSyntheticHardwareProbe: true
  const synthBlocked = makeHardwareEvaluation({ provenance: { probeKind: 'synthetic_fixture' } });
  const synthBlockedEval = value(evaluateAcceptance(synthBlocked.input, synthBlocked.artifacts));
  assert.equal(synthBlockedEval.spec.satisfied, false);
  assert.equal(synthBlockedEval.spec.required[0]!.status, 'blocked');
  assert.equal(synthBlockedEval.spec.required[0]!.reason, 'hardware_provenance_mismatch');
  assert.equal(synthBlockedEval.spec.diagnostics[0]!.code, 'HARDWARE_PROVENANCE_MISMATCH');
  assert.equal(validateDocument(synthBlockedEval, 'VerificationResult').ok, true);
  assert.equal(code(constructRunResult({
    trusted: { ...synthBlocked.input.trusted, usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: synthBlocked.input.claims, memory: { status: 'not_requested', reason: null } },
  }, synthBlocked.artifacts)), 'RUN_ACCEPTANCE_REQUIRED');

  const synthAllowed = makeHardwareEvaluation({
    allowSyntheticHardwareProbe: true,
    provenance: { probeKind: 'synthetic_fixture' },
  });
  assert.equal(value(evaluateAcceptance(synthAllowed.input, synthAllowed.artifacts)).spec.satisfied, true);

  // Every hardware mismatch downgrades passed claim to blocked (hardware_provenance_mismatch)
  for (const mismatch of [
    { targetCellId: 'wrong-cell' },
    { accelerator: 'sm_89' },
    { isolationMode: 'sliced' as const },
    { deviceCount: 4 },
    { topology: 'pcie-gen5' },
    { driverVersion: '545.23.08' },
  ]) {
    const f = makeHardwareEvaluation({ provenance: mismatch });
    const res = value(evaluateAcceptance(f.input, f.artifacts));
    assert.equal(res.spec.required[0]!.status, 'blocked', JSON.stringify(mismatch));
    assert.equal(res.spec.required[0]!.reason, 'hardware_provenance_mismatch', JSON.stringify(mismatch));
    assert.equal(res.spec.diagnostics[0]!.code, 'HARDWARE_PROVENANCE_MISMATCH', JSON.stringify(mismatch));
    assert.equal(validateDocument(res, 'VerificationResult').ok, true);
  }

  // Metric threshold violations downgrade passed claim to blocked (metric_threshold_failed) and refuse completed
  const badMetricCases: { label: string; rules: readonly MetricThresholdRule[]; metrics?: Record<string, number | string | boolean> }[] = [
    { label: 'missing metrics map', rules: [{ kind: 'bounds', metric: 'tflops', min: 1 }] },
    { label: 'missing metric key', rules: [{ kind: 'bounds', metric: 'tflops', min: 1 }], metrics: { other: 10 } },
    { label: 'string metric', rules: [{ kind: 'bounds', metric: 'tflops', min: 1 }], metrics: { tflops: '500' } },
    { label: 'boolean metric', rules: [{ kind: 'bounds', metric: 'tflops', min: 1 }], metrics: { tflops: true } },
    { label: 'below min', rules: [{ kind: 'bounds', metric: 'tflops', min: 400 }], metrics: { tflops: 399.9 } },
    { label: 'above max', rules: [{ kind: 'bounds', metric: 'err', max: 1e-4 }], metrics: { err: 2e-4 } },
    { label: 'min_ratio fail', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: 1.5 }], metrics: { a: 14, b: 10 } },
    { label: 'min_ratio baseline zero', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: 1 }], metrics: { a: 10, b: 0 } },
    { label: 'min_ratio baseline negative', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: 1 }], metrics: { a: -20, b: -10 } },
    { label: 'max_ratio fail', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: 0.5 }], metrics: { a: 6, b: 10 } },
    { label: 'max_ratio baseline zero', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: 0.5 }], metrics: { a: 0, b: 0 } },
    { label: 'max_delta fail', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_delta', threshold: 5 }], metrics: { a: 16, b: 10 } },
    { label: 'comparative missing baseline', rules: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_delta', threshold: 5 }], metrics: { a: 10 } },
  ];

  for (const testCase of badMetricCases) {
    const f = makeHardwareEvaluation({
      metricThresholds: testCase.rules,
      ...(testCase.metrics !== undefined ? { metrics: testCase.metrics } : {}),
    });
    const res = value(evaluateAcceptance(f.input, f.artifacts));
    assert.equal(res.spec.required[0]!.status, 'blocked', testCase.label);
    assert.equal(res.spec.required[0]!.reason, 'metric_threshold_failed', testCase.label);
    assert.equal(res.spec.diagnostics[0]!.code, 'METRIC_THRESHOLD_FAILED', testCase.label);
    assert.equal(validateDocument(res, 'VerificationResult').ok, true, testCase.label);
    assert.equal(code(constructRunResult({
      trusted: { ...f.input.trusted, usage: [], externalEffects: 'none', noChange: null },
      candidate: { status: 'completed', checks: f.input.claims, memory: { status: 'not_requested', reason: null } },
    }, f.artifacts)), 'RUN_ACCEPTANCE_REQUIRED', testCase.label);
  }

  // max_delta succeeds even when baseline <= 0
  const negBaselineDelta = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_delta', threshold: 5 }],
    metrics: { a: -5, b: -10 },
  });
  assert.equal(value(evaluateAcceptance(negBaselineDelta.input, negBaselineDelta.artifacts)).spec.satisfied, true);

  // Signed ratio thresholds and floating-point overflow preserve exact comparison direction
  const signedRatioPass = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: -0.5 }],
    metrics: { a: -1, b: 1 },
  });
  assert.equal(value(evaluateAcceptance(signedRatioPass.input, signedRatioPass.artifacts)).spec.satisfied, true);

  const posOverflowMinRatio = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: 2 }],
    metrics: { a: 1e300, b: 1e-100 },
  });
  assert.equal(value(evaluateAcceptance(posOverflowMinRatio.input, posOverflowMinRatio.artifacts)).spec.satisfied, true);

  const posOverflowMaxRatioFail = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: 2 }],
    metrics: { a: 1e300, b: 1e-100 },
  });
  assert.equal(value(evaluateAcceptance(posOverflowMaxRatioFail.input, posOverflowMaxRatioFail.artifacts)).spec.required[0]!.reason, 'metric_threshold_failed');

  const negOverflowMaxRatio = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_ratio', threshold: -2 }],
    metrics: { a: -1e300, b: 1e-100 },
  });
  assert.equal(value(evaluateAcceptance(negOverflowMaxRatio.input, negOverflowMaxRatio.artifacts)).spec.satisfied, true);

  const negOverflowMinRatioFail = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'min_ratio', threshold: -2 }],
    metrics: { a: -1e300, b: 1e-100 },
  });
  assert.equal(value(evaluateAcceptance(negOverflowMinRatioFail.input, negOverflowMinRatioFail.artifacts)).spec.required[0]!.reason, 'metric_threshold_failed');

  const negOverflowMaxDelta = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_delta', threshold: 0 }],
    metrics: { a: -1e308, b: 1e308 },
  });
  assert.equal(value(evaluateAcceptance(negOverflowMaxDelta.input, negOverflowMaxDelta.artifacts)).spec.satisfied, true);

  const posOverflowMaxDeltaFail = makeHardwareEvaluation({
    metricThresholds: [{ kind: 'comparative', metric: 'a', baselineMetric: 'b', operator: 'max_delta', threshold: 0 }],
    metrics: { a: 1e308, b: -1e308 },
  });
  assert.equal(value(evaluateAcceptance(posOverflowMaxDeltaFail.input, posOverflowMaxDeltaFail.artifacts)).spec.required[0]!.reason, 'metric_threshold_failed');
});

test('verifier CAS namespace paths are budgeted separately from candidate overlay and blocked from candidate smuggling', () => {
  // Path parser checks
  assert.equal(isVerifierNamespacePath('.loopwright-verifier/bench-gpu/kernel.cubin'), true);
  assert.equal(isVerifierNamespacePath('.LOOPWRIGHT-VERIFIER/bench-gpu/kernel.cubin'), true);
  assert.equal(isVerifierNamespacePath('packages/core/src/index.ts'), false);
  assert.deepEqual(parseVerifierArtifactPath('.loopwright-verifier/bench-gpu/build/kernel.cubin'), {
    slotId: 'bench-gpu',
    relativePath: 'build/kernel.cubin',
  });
  // Controller derived slot IDs support full 58..64 char check IDs; 65 char check IDs are rejected
  const checkId58 = `c${'a'.repeat(57)}`;
  const checkId64 = `c${'a'.repeat(63)}`;
  const checkId65 = `c${'a'.repeat(64)}`;
  assert.deepEqual(parseVerifierArtifactPath(`.loopwright-verifier/check.${checkId58}/kernel.cubin`), {
    slotId: `check.${checkId58}`,
    relativePath: 'kernel.cubin',
  });
  assert.deepEqual(parseVerifierArtifactPath(`.loopwright-verifier/check.${checkId64}/kernel.cubin`), {
    slotId: `check.${checkId64}`,
    relativePath: 'kernel.cubin',
  });
  assert.equal(validateRelativePath(`.loopwright-verifier/check.${checkId64}/kernel.cubin`).ok, true);
  assert.equal(parseVerifierArtifactPath(`.loopwright-verifier/check.${checkId65}/kernel.cubin`), null);

  for (const invalidPath of [
    '.loopwright-verifier',
    '.loopwright-verifier/bench-gpu',
    '.loopwright-verifier/BadSlot/kernel.cubin',
    '.LOOPWRIGHT-VERIFIER/bench-gpu/kernel.cubin',
    '.loopwright-verifier/con/kernel.cubin',
    '.loopwright-verifier/nul/kernel.cubin',
    '.loopwright-verifier/bench-gpu/../escape.cubin',
    '.loopwright-verifier/bench-gpu/CON',
  ]) {
    assert.equal(parseVerifierArtifactPath(invalidPath), null, invalidPath);
    if (invalidPath.includes('/con/') || invalidPath.includes('/nul/')) {
      assert.equal(validateRelativePath(invalidPath).ok, false, invalidPath);
    }
    assert.equal(code(digestArtifact(invalidPath, new Uint8Array([1]))), 'PATH_INVALID', invalidPath);
    assert.equal(code(digestArtifactFromMetadata(invalidPath, { digest: WORKLOAD_DIGEST, byteLength: 1 })), 'PATH_INVALID', invalidPath);
  }

  // Contradictory verifier CAS URI is rejected at digestArtifact, digestArtifactFromMetadata, Evidence, and evaluateAcceptance
  assert.equal(code(digestArtifact('.loopwright-verifier/check.tests/out.cubin', new Uint8Array([1]), {
    uri: `cas://sha256/${'f'.repeat(64)}`,
  })), 'ARTIFACT_DIGEST_MISMATCH');
  assert.equal(code(digestArtifactFromMetadata('.loopwright-verifier/check.tests/out.cubin', {
    digest: WORKLOAD_DIGEST,
    byteLength: 1,
    uri: `cas://sha256/${'f'.repeat(64)}`,
  })), 'ARTIFACT_DIGEST_MISMATCH');
  assert.equal(code(digestArtifactFromMetadata('.loopwright-verifier/check.tests/out.cubin', {
    digest: WORKLOAD_DIGEST,
    byteLength: 1,
    uri: 'file:///tmp/evil.cubin',
  })), 'VALUE_RANGE');

  // Candidate writes to .loopwright-verifier/** are never permitted even with writable: ['**']
  const wideContract = contract();
  wideContract.spec.scope.writable = ['**'];
  wideContract.spec.scope.protected = [];
  assert.equal(value(isWritablePath(wideContract, 'packages/app.ts')), true);
  assert.equal(value(isWritablePath(wideContract, '.loopwright-verifier/bench-gpu/kernel.cubin')), false);
  assert.equal(value(isWritablePath(wideContract, '.LOOPWRIGHT-VERIFIER/bench-gpu/kernel.cubin')), false);

  // Candidate manifests cannot smuggle .loopwright-verifier paths (classic or overlay entries/deleted)
  const verifierRef = value(digestArtifactFromMetadata('.loopwright-verifier/bench-gpu/kernel.cubin', {
    digest: WORKLOAD_DIGEST,
    byteLength: 128,
  }));
  const smuggledClassic = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [verifierRef] },
  };
  assert.equal(code(identifyManifest(smuggledClassic)), 'PATH_INVALID');

  const smuggledOverlayDelete = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: {
      baseTree: { objectFormat: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
      entries: [],
      deleted: ['.loopwright-verifier/bench-gpu/kernel.cubin'],
    },
  };
  assert.equal(code(identifyManifest(smuggledOverlayDelete)), 'PATH_INVALID');

  // Saturated candidate 4 MiB / 128-file overlay + 64 large verifier CAS binaries (1 GiB total) succeeds!
  const overlayOpts = { overlay: { maxFiles: OVERLAY_LIMITS.defaultMaxFiles, maxBytes: OVERLAY_LIMITS.defaultMaxBytes } } as const;
  const candidateFiles: ResolvedArtifactInput[] = Array.from({ length: 128 }, (_, i) => ({
    name: `src/f-${String(i).padStart(3, '0')}.ts`,
    byteLength: 32_768, // 128 * 32 KiB = exactly 4 MiB
    digest: { algorithm: 'sha256', hex: 'a'.repeat(64) },
  }));
  const verifierOutputs: ResolvedArtifactInput[] = Array.from({ length: VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot }, (_, i) => ({
    name: `.loopwright-verifier/bench-gpu/kernel-${String(i).padStart(2, '0')}.cubin`,
    byteLength: 16 * 1024 * 1024, // 64 * 16 MiB = 1 GiB
    digest: { algorithm: 'sha256', hex: 'b'.repeat(64) },
  }));
  const resolved = resolveInventory([...candidateFiles, ...verifierOutputs], overlayOpts);
  assert.equal(resolved.size, 128 + 64);

  // Candidate adding 1 byte over 4 MiB STILL fails closed with LIMIT_RESOLVED_BYTES
  assert.throws(
    () => resolveInventory([
      ...candidateFiles,
      { name: 'src/extra.ts', byteLength: 1, digest: { algorithm: 'sha256', hex: 'c'.repeat(64) } },
      ...verifierOutputs,
    ], overlayOpts),
    (err: unknown) => err instanceof Error && err.message === 'LIMIT_RESOLVED_BYTES',
  );

  // Verifier per-slot cap (65 files in one slot) fails with LIMIT_COLLECTION
  assert.throws(
    () => resolveInventory([
      ...verifierOutputs,
      { name: '.loopwright-verifier/bench-gpu/kernel-64.cubin', byteLength: 16, digest: WORKLOAD_DIGEST },
    ], overlayOpts),
    (err: unknown) => err instanceof Error && err.message === 'LIMIT_COLLECTION',
  );

  // Verifier total cap (256 across 4 slots succeeds; 257 fails with LIMIT_COLLECTION)
  const fourSlots256: ResolvedArtifactInput[] = Array.from({ length: VERIFIER_ARTIFACT_LIMITS.maxTotalFiles }, (_, i) => ({
    name: `.loopwright-verifier/slot-${Math.floor(i / 64)}/out-${i}.sass`,
    byteLength: 64,
    digest: WORKLOAD_DIGEST,
  }));
  assert.equal(resolveInventory(fourSlots256, overlayOpts).size, 256);
  assert.throws(
    () => resolveInventory([
      ...fourSlots256,
      { name: '.loopwright-verifier/slot-4/out-256.sass', byteLength: 64, digest: WORKLOAD_DIGEST },
    ], overlayOpts),
    (err: unknown) => err instanceof Error && err.message === 'LIMIT_COLLECTION',
  );

  // Verifier single-file and aggregate byte caps enforced
  assert.throws(
    () => resolveInventory([
      { name: '.loopwright-verifier/bench-gpu/too-big.cubin', byteLength: VERIFIER_ARTIFACT_LIMITS.maxFileBytes + 1, digest: WORKLOAD_DIGEST },
    ], overlayOpts),
    (err: unknown) => err instanceof Error && err.message === 'LIMIT_ARTIFACT_BYTES',
  );
  assert.throws(
    () => resolveInventory([
      { name: '.loopwright-verifier/bench-gpu/a.cubin', byteLength: VERIFIER_ARTIFACT_LIMITS.maxTotalBytes, digest: WORKLOAD_DIGEST },
      { name: '.loopwright-verifier/bench-gpu/b.cubin', byteLength: 1, digest: WORKLOAD_DIGEST },
    ], overlayOpts),
    (err: unknown) => err instanceof Error && err.message === 'LIMIT_RESOLVED_BYTES',
  );

  // Malformed verifier path and duplicate verifier path fail closed in resolveInventory
  assert.throws(
    () => resolveInventory([{ name: '.loopwright-verifier/BadSlot/out.cubin', byteLength: 16, digest: WORKLOAD_DIGEST }]),
    (err: unknown) => err instanceof Error && err.message === 'PATH_INVALID',
  );
  assert.throws(
    () => resolveInventory([
      { name: '.loopwright-verifier/bench-gpu/out.cubin', byteLength: 16, digest: WORKLOAD_DIGEST },
      { name: '.loopwright-verifier/bench-gpu/OUT.cubin', byteLength: 16, digest: WORKLOAD_DIGEST },
    ]),
    (err: unknown) => err instanceof Error && err.message === 'ARTIFACT_DUPLICATE',
  );

  // Raw Uint8Array under .loopwright-verifier/<slotId>/* succeeds within raw caps and is counted in verifier slot budget
  const rawVerifier = resolveInventory([
    { name: '.loopwright-verifier/bench-gpu/profile.json', bytes: Buffer.from('{"ok":true}\n') },
  ], overlayOpts);
  assert.equal(rawVerifier.get('.loopwright-verifier/bench-gpu/profile.json')?.byteLength, 12);

  // End-to-end evaluateAcceptance with 4 MiB candidate overlay + 256 MiB .cubin verifier artifact passes!
  const hwTask = makeHardwareContract();
  Object.assign(hwTask.spec.budgets, { overlay: { maxFiles: 128, maxBytes: OVERLAY_LIMITS.defaultMaxBytes } });
  const hwLock = value(admitTask(hwTask, ADMISSION));
  const candidateEntry = value(digestArtifactFromMetadata('packages/kernel.cu', {
    digest: { algorithm: 'sha256', hex: '1'.repeat(64) },
    byteLength: OVERLAY_LIMITS.defaultMaxBytes, // full 4 MiB candidate budget
  }));
  const hwManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: {
      baseTree: { objectFormat: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) },
      entries: [candidateEntry],
      deleted: [] as string[],
    },
  };
  const hwSubject = value(bindSubject(hwLock, hwManifest));
  const cubinRef = value(digestArtifactFromMetadata('.loopwright-verifier/check.tests/kernel.cubin', {
    digest: { algorithm: 'sha256', hex: '2'.repeat(64) },
    byteLength: 256 * 1024 * 1024, // 256 MiB verifier output >> 4 MiB overlay cap
    uri: `cas://sha256/${'2'.repeat(64)}`,
    mediaType: 'application/octet-stream',
  }));
  const receiptRef = value(digestArtifact('gate-output.json', Buffer.from('{"ok":true}\n')));
  const hwEvidence = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Evidence',
    metadata: { id: 'observation-hw-1' },
    spec: {
      checkId: 'tests',
      observedStatus: 'passed',
      producerId: 'benchmark-gate',
      method: 'benchmark-gate.v1',
      level: 'hardware_execution',
      subject: structuredClone(hwSubject),
      artifacts: [receiptRef, cubinRef],
      reason: null,
      hardwareProvenance: makeProvenance(),
    },
  };
  const hwEval = value(evaluateAcceptance(
    {
      trusted: { expectedLock: hwLock, candidateManifest: hwManifest, eligibleEvidence: [hwEvidence] },
      claims: [{ checkId: 'tests', status: 'passed', evidenceId: 'observation-hw-1', reason: null }],
    },
    [
      { name: 'packages/kernel.cu', byteLength: OVERLAY_LIMITS.defaultMaxBytes, digest: { algorithm: 'sha256', hex: '1'.repeat(64) } },
      { name: 'gate-output.json', bytes: Buffer.from('{"ok":true}\n') },
      { name: '.loopwright-verifier/check.tests/kernel.cubin', byteLength: 256 * 1024 * 1024, digest: { algorithm: 'sha256', hex: '2'.repeat(64) } },
    ],
  ));
  assert.equal(hwEval.spec.satisfied, true);
  assert.equal(hwEval.spec.required[0]!.status, 'passed');

  // Contradictory CAS URI in Evidence is rejected at validateDocument and evaluateAcceptance
  const badCasEvidence = structuredClone(hwEvidence);
  badCasEvidence.spec.artifacts = [{ ...cubinRef, uri: `cas://sha256/${'9'.repeat(64)}` }];
  assert.equal(code(validateDocument(badCasEvidence, 'Evidence')), 'ARTIFACT_DIGEST_MISMATCH');
  assert.equal(code(evaluateAcceptance(
    {
      trusted: { expectedLock: hwLock, candidateManifest: hwManifest, eligibleEvidence: [badCasEvidence] },
      claims: [{ checkId: 'tests', status: 'passed', evidenceId: 'observation-hw-1', reason: null }],
    },
    [
      { name: 'packages/kernel.cu', byteLength: OVERLAY_LIMITS.defaultMaxBytes, digest: { algorithm: 'sha256', hex: '1'.repeat(64) } },
      { name: '.loopwright-verifier/check.tests/kernel.cubin', byteLength: 256 * 1024 * 1024, digest: { algorithm: 'sha256', hex: '2'.repeat(64) } },
    ],
  )), 'ARTIFACT_DIGEST_MISMATCH');

  // Foreign verifier slot ref and mixed alias slot refs are rejected
  const foreignEvidence = structuredClone(hwEvidence);
  foreignEvidence.spec.artifacts = [
    receiptRef,
    { ...cubinRef, name: '.loopwright-verifier/check.other/kernel.cubin' },
  ];
  assert.equal(code(validateDocument(foreignEvidence, 'Evidence')), 'PATH_INVALID');

  const mixedAliasEvidence = structuredClone(hwEvidence);
  mixedAliasEvidence.spec.artifacts = [
    structuredClone(cubinRef),
    { ...structuredClone(cubinRef), name: '.loopwright-verifier/tests/second.cubin' },
  ];
  assert.equal(code(validateDocument(mixedAliasEvidence, 'Evidence')), 'PATH_INVALID');

  // Ordinary receipt + 64 own verifier outputs succeeds; 65th own verifier output fails with LIMIT_COLLECTION
  const own64Refs = Array.from({ length: VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot }, (_, i) => ({
    name: `.loopwright-verifier/check.tests/out-${i}.cubin`,
    digest: { algorithm: 'sha256' as const, hex: '2'.repeat(64) },
    byteLength: 16,
    uri: `cas://sha256/${'2'.repeat(64)}`,
  }));
  const batch64Evidence = structuredClone(hwEvidence);
  batch64Evidence.spec.artifacts = [receiptRef, ...own64Refs];
  assert.equal(validateDocument(batch64Evidence, 'Evidence').ok, true);

  const batch65Evidence = structuredClone(hwEvidence);
  batch65Evidence.spec.artifacts = [
    receiptRef,
    ...own64Refs,
    {
      name: '.loopwright-verifier/check.tests/out-64.cubin',
      digest: { algorithm: 'sha256' as const, hex: '2'.repeat(64) },
      byteLength: 16,
      uri: `cas://sha256/${'2'.repeat(64)}`,
    },
  ];
  assert.equal(code(validateDocument(batch65Evidence, 'Evidence')), 'LIMIT_COLLECTION');
});
