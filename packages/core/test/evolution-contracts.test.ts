import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitTask,
  bindSubject,
  constructRunResult,
  evaluateAcceptance,
  evaluateMetricThresholds,
  validateBucketMetrics,
  validateDocument,
  validateHardwareDiagnostics,
  DIAGNOSTIC_CODES,
  EXPORT_UNVERIFIED_FORBIDDEN,
  HARDWARE_BOUND_PIPELINES,
  LIMITS,
  SecretScrubber,
  STAGE_A_STATIC_AUDIT_FAILED,
  TEAM_ENVELOPE_VIOLATION,
  type BucketMetricEntry,
  type Digest,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type MetricBucketScope,
  type MetricThresholdRule,
} from '../src/index.js';
import { hardwareTargetSchema } from '../src/contracts.js';
import { bucketMetricsSchema, hardwareDiagnosticsSchema } from '../src/evidence.js';
import { canonical } from '../src/identity.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

const ADMISSION = { admissionId: 'admission-1', runId: 'run-1' };
const WORKLOAD_DIGEST: Digest = { algorithm: 'sha256', hex: 'd'.repeat(64) };

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
  readonly metricThresholds?: readonly MetricThresholdRule[];
  readonly metrics?: Record<string, number | string | boolean>;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
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
    ...(options?.metricThresholds !== undefined ? { metricThresholds: options.metricThresholds } : {}),
  });
  const fixture = evaluationFixture(task);
  Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, {
    level: 'hardware_execution',
    hardwareProvenance: makeProvenance(),
    ...(options?.metrics !== undefined ? { metrics: options.metrics } : {}),
    ...(options?.bucketMetrics !== undefined ? { bucketMetrics: options.bucketMetrics } : {}),
    ...(options?.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: options.hardwareDiagnostics } : {}),
  });
  return fixture;
}

test('evolution diagnostic constants are exported and registered in frozen DIAGNOSTIC_CODES', () => {
  assert.equal(STAGE_A_STATIC_AUDIT_FAILED, 'STAGE_A_STATIC_AUDIT_FAILED');
  assert.equal(TEAM_ENVELOPE_VIOLATION, 'TEAM_ENVELOPE_VIOLATION');
  assert.equal(EXPORT_UNVERIFIED_FORBIDDEN, 'EXPORT_UNVERIFIED_FORBIDDEN');
  assert.equal(DIAGNOSTIC_CODES.includes(STAGE_A_STATIC_AUDIT_FAILED), true);
  assert.equal(DIAGNOSTIC_CODES.includes(TEAM_ENVELOPE_VIOLATION), true);
  assert.equal(DIAGNOSTIC_CODES.includes(EXPORT_UNVERIFIED_FORBIDDEN), true);
  assert.equal(Object.isFrozen(DIAGNOSTIC_CODES), true);

  // New diagnostic codes validate cleanly inside VerificationResult.spec.diagnostics
  const fixture = evaluationFixture();
  const baseResult = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  const withEvolutionDiagnostics = {
    ...baseResult,
    spec: {
      ...baseResult.spec,
      diagnostics: [
        { code: STAGE_A_STATIC_AUDIT_FAILED, path: '/stageA', checkId: 'tests' },
        { code: TEAM_ENVELOPE_VIOLATION, path: '/teamPatch', checkId: null },
        { code: EXPORT_UNVERIFIED_FORBIDDEN, path: '/bundle', checkId: null },
      ],
    },
  };
  assert.equal(validateDocument(withEvolutionDiagnostics, 'VerificationResult').ok, true);
});

test('HardwareTargetSpec Stage A static audit fields validate bounds and preserve legacy canonical digests when omitted', () => {
  const baseTask = contract();
  Object.assign(baseTask.spec.target, {
    matrix: [{
      id: 'h100-sm90',
      platform: 'linux',
      variant: 'cuda',
      hardware: {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
        driverConstraint: '>=550.54.15',
        topology: 'nvlink-8x',
      },
    }],
  });
  const baseLock = value(admitTask(baseTask, ADMISSION));
  const baseHw = baseLock.spec.contract.spec.target.matrix![0]!.hardware!;
  assert.equal(Object.hasOwn(baseHw, 'forbiddenSymbolPatterns'), false);
  assert.equal(Object.hasOwn(baseHw, 'maxRegisterCount'), false);
  assert.equal(Object.hasOwn(baseHw, 'maxLocalSpillBytes'), false);

  const manifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [] },
  };
  const baseSubject = value(bindSubject(baseLock, manifest));

  // Valid Stage A static audit fields: empty patterns (0), realistic patterns, 64 patterns, 0 ceilings
  const withHardware = (hardware: unknown) => {
    const task = contract();
    Object.assign(task.spec.target, {
      matrix: [{ id: 'h100-sm90', platform: 'linux', variant: 'cuda', hardware }],
    });
    return validateDocument(task, 'TaskContract');
  };

  const fullHw: HardwareTargetSpec = {
    accelerator: 'sm_90a',
    isolationMode: 'whole_device',
    forbiddenSymbolPatterns: ['cublas', 'cudnn', 'rocblas', 'miopen', 'aclnn', 'at::native::', 'torch_cuda'],
    maxRegisterCount: 128,
    maxLocalSpillBytes: 0,
  };
  const parsedFull = value(withHardware(fullHw));
  const parsedHw = parsedFull.spec.target.matrix![0]!.hardware!;
  assert.equal(Object.getPrototypeOf(parsedHw), null);
  assert.deepEqual(parsedHw.forbiddenSymbolPatterns, fullHw.forbiddenSymbolPatterns);
  assert.equal(parsedHw.maxRegisterCount, 128);
  assert.equal(parsedHw.maxLocalSpillBytes, 0);

  // Adding Stage A static audit fields changes targetMatrixDigest, contractHash, and lockHash
  const auditTask = contract();
  Object.assign(auditTask.spec.target, {
    matrix: [{
      id: 'h100-sm90',
      platform: 'linux',
      variant: 'cuda',
      hardware: {
        accelerator: 'sm_90a',
        isolationMode: 'whole_device',
        deviceCount: 1,
        driverConstraint: '>=550.54.15',
        topology: 'nvlink-8x',
        forbiddenSymbolPatterns: ['cublas'],
        maxRegisterCount: 255,
        maxLocalSpillBytes: 0,
      },
    }],
  });
  const auditLock = value(admitTask(auditTask, ADMISSION));
  const auditSubject = value(bindSubject(auditLock, manifest));
  assert.notEqual(auditSubject.targetMatrixDigest?.hex, baseSubject.targetMatrixDigest?.hex);
  assert.notEqual(auditLock.spec.contractHash.hex, baseLock.spec.contractHash.hex);
  assert.notEqual(auditLock.spec.lockHash.hex, baseLock.spec.lockHash.hex);

  // Boundary counts: 0 patterns, 64 patterns (max length 128), 65 rejected
  assert.equal(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: [] }).ok, true);
  const patterns64 = Array.from({ length: LIMITS.forbiddenSymbolPatterns }, (_, i) => `sym_${String(i).padStart(2, '0')}`);
  assert.equal(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: patterns64 }).ok, true);
  assert.equal(
    withHardware({
      accelerator: 'sm_90a',
      isolationMode: 'whole_device',
      forbiddenSymbolPatterns: ['a'.repeat(LIMITS.forbiddenSymbolPattern)],
    }).ok,
    true,
  );
  assert.equal(
    code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: [...patterns64, 'extra'] })),
    'VALUE_RANGE',
  );

  // Invalid forbiddenSymbolPatterns entries
  for (const badPattern of ['', ' cublas', 'cublas ', 'cublas\n', 'cublas\t', 'c\u00FCblas', 'a'.repeat(LIMITS.forbiddenSymbolPattern + 1)]) {
    assert.equal(
      code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: [badPattern] })),
      'VALUE_RANGE',
      badPattern,
    );
  }
  assert.equal(
    code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: ['cublas\uD800'] })),
    'INPUT_UNSUPPORTED',
  );
  for (const globPattern of ['cublas*', 'cublas?', 'cublas[0]', 'cublas]']) {
    assert.equal(
      code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: [globPattern] })),
      'PATTERN_UNSUPPORTED',
      globPattern,
    );
  }
  assert.equal(
    code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: ['cublas', 'cublas'] })),
    'DUPLICATE_ID',
  );
  assert.equal(
    code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', forbiddenSymbolPatterns: [123] })),
    'VALUE_TYPE',
  );

  // maxRegisterCount and maxLocalSpillBytes bounds and type checks
  assert.equal(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', maxRegisterCount: 0, maxLocalSpillBytes: 0 }).ok, true);
  for (const field of ['maxRegisterCount', 'maxLocalSpillBytes'] as const) {
    for (const badNum of [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', [field]: badNum })),
        'VALUE_RANGE',
        `${field}=${String(badNum)}`,
      );
    }
    assert.equal(
      code(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', [field]: '64' })),
      'VALUE_TYPE',
      field,
    );
    // Boundary snapshot normalizes -0 -> 0 in validateDocument
    const negZeroDoc = value(withHardware({ accelerator: 'sm_90a', isolationMode: 'whole_device', [field]: -0 }));
    const parsedVal = negZeroDoc.spec.target.matrix![0]!.hardware![field];
    assert.equal(Object.is(parsedVal, 0), true);
    assert.equal(Object.is(parsedVal, -0), false);
    // Direct schema rejects raw -0
    assert.throws(
      () => hardwareTargetSchema({ accelerator: 'sm_90a', isolationMode: 'whole_device', [field]: -0 }, '/hw'),
      (err: unknown) => err instanceof Error && err.message === 'VALUE_RANGE',
    );
  }
});

test('MetricThresholdRule.bucketScope validates all variants and preserves legacy hashes when omitted', () => {
  const legacyTask = contract();
  Object.assign(legacyTask.spec.acceptance.checks[0]!, {
    metricThresholds: [
      { kind: 'bounds', metric: 'max_ulp', max: 1 },
      { kind: 'comparative', metric: 'latency_us', baselineMetric: 'base_latency_us', operator: 'max_ratio', threshold: 0.9 },
    ],
  });
  const legacyLock = value(admitTask(legacyTask, ADMISSION));
  const rules = legacyLock.spec.contract.spec.acceptance.checks[0]!.metricThresholds!;
  assert.equal(Object.hasOwn(rules[0]!, 'bucketScope'), false);
  assert.equal(Object.hasOwn(rules[1]!, 'bucketScope'), false);

  const withThresholds = (metricThresholds: unknown) => {
    const task = contract();
    Object.assign(task.spec.acceptance.checks[0]!, { metricThresholds });
    return validateDocument(task, 'TaskContract');
  };

  // Valid scopes on both bounds and comparative rules
  const validRules: readonly MetricThresholdRule[] = [
    { kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'aggregate' },
    { kind: 'bounds', metric: 'token_force_max_delta', max: 0.02, bucketScope: 'all_buckets' },
    { kind: 'bounds', metric: 'latency_us_p50', max: 100, bucketScope: { bucketId: 'bs1-isl4k' } },
    {
      kind: 'comparative',
      metric: 'latency_us_p50',
      baselineMetric: 'baseline_latency_us_p50',
      operator: 'max_ratio',
      threshold: 0.85,
      bucketScope: 'all_buckets',
    },
    {
      kind: 'comparative',
      metric: 'goodput_rps',
      baselineMetric: 'baseline_goodput_rps',
      operator: 'min_ratio',
      threshold: 1.15,
      bucketScope: { bucketId: 'bs16_isl8k:fp16' },
    },
  ];
  const parsed = value(withThresholds(validRules));
  const parsedScope = parsed.spec.acceptance.checks[0]!.metricThresholds![2]!.bucketScope;
  assert.equal(typeof parsedScope, 'object');
  assert.equal(Object.getPrototypeOf(parsedScope), null);
  assert.deepEqual({ ...(parsedScope as { readonly bucketId: string }) }, { bucketId: 'bs1-isl4k' });

  // Invalid bucketScope values
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'a', max: 1, bucketScope: 'some_buckets' }])), 'VALUE_ENUM');
  for (const badType of [123, true, null, []]) {
    assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'a', max: 1, bucketScope: badType }])), 'VALUE_TYPE');
  }
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'a', max: 1, bucketScope: {} }])), 'FIELD_REQUIRED');
  assert.equal(code(withThresholds([{ kind: 'bounds', metric: 'a', max: 1, bucketScope: { bucketId: 'bs1', extra: true } }])), 'FIELD_UNKNOWN');
  for (const badId of ['', 'a'.repeat(LIMITS.bucketId + 1), 'ghp_123456789012345678901234', 'OPENAI_API_KEY']) {
    assert.equal(
      code(withThresholds([{ kind: 'bounds', metric: 'a', max: 1, bucketScope: { bucketId: badId } }])),
      'VALUE_RANGE',
      badId,
    );
  }
  for (const badId of ['bad space', '../escape', '-leading', 'constructor', 'prototype', '__proto__', 'bücket']) {
    assert.equal(
      code(withThresholds([{ kind: 'bounds', metric: 'a', max: 1, bucketScope: { bucketId: badId } }])),
      'IDENTIFIER_INVALID',
      badId,
    );
  }
});

test('Evidence.spec.bucketMetrics validates 1..64 buckets, <=16 numeric metrics, <=8 dimensions, null-proto, and secret guards', () => {
  // Legacy Evidence omits bucketMetrics and hardwareDiagnostics cleanly
  const baseline = evaluationFixture();
  const baseEv = value(validateDocument(baseline.input.trusted.eligibleEvidence[0], 'Evidence'));
  assert.equal(Object.hasOwn(baseEv.spec, 'bucketMetrics'), false);
  assert.equal(Object.hasOwn(baseEv.spec, 'hardwareDiagnostics'), false);

  const withBucketMetrics = (bucketMetrics: unknown) => {
    const fixture = evaluationFixture();
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { bucketMetrics });
    return validateDocument(fixture.input.trusted.eligibleEvidence[0], 'Evidence');
  };

  // Exact maximum boundaries: 64 buckets, 16 numeric metrics, 8 dimensions
  const maxBuckets: BucketMetricEntry[] = Array.from({ length: LIMITS.bucketMetrics }, (_, i) => ({
    bucketId: `bucket_${String(i).padStart(2, '0')}`,
    dimensions: Object.fromEntries([
      ['bs', i + 1],
      ['isl', 4096],
      ['osl', 512],
      ['dtype', 'fp16'],
      ['layout', 'row-major'],
      ['tp', 1],
      ['kv_dtype', 'fp8_e4m3'],
      ['causal', 'true'],
    ]),
    metrics: Object.fromEntries(Array.from({ length: LIMITS.bucketMetricEntries }, (_, m) => [`m_${m}`, m + 0.5])),
  }));
  const parsedMax = value(withBucketMetrics(maxBuckets));
  assert.equal(parsedMax.spec.bucketMetrics?.length, 64);
  assert.equal(Object.getPrototypeOf(parsedMax.spec.bucketMetrics![0]), null);
  assert.equal(Object.getPrototypeOf(parsedMax.spec.bucketMetrics![0]!.dimensions), null);
  assert.equal(Object.getPrototypeOf(parsedMax.spec.bucketMetrics![0]!.metrics), null);

  // Optional dimensions omitted when absent
  const noDims = value(withBucketMetrics([{ bucketId: 'bs1-isl4k', metrics: { latency_us_p50: 42.5, max_ulp: 0 } }]));
  assert.equal(Object.hasOwn(noDims.spec.bucketMetrics![0]!, 'dimensions'), false);

  // Boundary overruns
  assert.equal(code(withBucketMetrics([])), 'VALUE_RANGE');
  assert.equal(code(withBucketMetrics([...maxBuckets, { bucketId: 'bucket_64', metrics: { m_0: 1 } }])), 'VALUE_RANGE');
  assert.equal(
    code(withBucketMetrics([{
      bucketId: 'b0',
      metrics: Object.fromEntries(Array.from({ length: LIMITS.bucketMetricEntries + 1 }, (_, m) => [`m_${m}`, m])),
    }])),
    'VALUE_RANGE',
  );
  assert.equal(
    code(withBucketMetrics([{
      bucketId: 'b0',
      dimensions: Object.fromEntries(Array.from({ length: LIMITS.bucketDimensionEntries + 1 }, (_, d) => [`d_${d}`, d])),
      metrics: { m_0: 1 },
    }])),
    'VALUE_RANGE',
  );

  // Duplicate bucketId rejected
  assert.equal(
    code(withBucketMetrics([
      { bucketId: 'bs1-isl4k', metrics: { latency_us: 10 } },
      { bucketId: 'bs1-isl4k', metrics: { latency_us: 12 } },
    ])),
    'DUPLICATE_ID',
  );

  // Non-numeric bucket metric values rejected (prevents free-text exfiltration)
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', metrics: { note: 'leaked text' } }])), 'VALUE_TYPE');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', metrics: { flag: true } }])), 'VALUE_TYPE');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', metrics: { bad: null } }])), 'VALUE_TYPE');

  // Non-finite numbers rejected; -0 normalized via validateDocument and rejected in direct schema
  for (const badNum of [NaN, Infinity, -Infinity]) {
    assert.equal(code(withBucketMetrics([{ bucketId: 'b0', metrics: { lat: badNum } }])), 'VALUE_RANGE');
    assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { bs: badNum }, metrics: { lat: 1 } }])), 'VALUE_RANGE');
  }
  const negZeroEv = value(withBucketMetrics([{ bucketId: 'b0', dimensions: { bs: -0 }, metrics: { delta: -0 } }]));
  assert.equal(Object.is(negZeroEv.spec.bucketMetrics![0]!.dimensions!.bs, 0), true);
  assert.equal(Object.is(negZeroEv.spec.bucketMetrics![0]!.metrics.delta, 0), true);
  assert.throws(
    () => bucketMetricsSchema([{ bucketId: 'b0', metrics: { delta: -0 } }], '/bucketMetrics'),
    (err: unknown) => err instanceof Error && err.message === 'VALUE_RANGE',
  );
  assert.throws(
    () => bucketMetricsSchema([{ bucketId: 'b0', dimensions: { bs: -0 }, metrics: { delta: 1 } }], '/bucketMetrics'),
    (err: unknown) => err instanceof Error && err.message === 'VALUE_RANGE',
  );

  // Free-text, non-ASCII, lone surrogate, prototype pollution, and secret exfiltration rejected
  assert.equal(code(withBucketMetrics([{ bucketId: 'free text prompt', metrics: { x: 1 } }])), 'IDENTIFIER_INVALID');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { tag: 'secret prompt sentence' }, metrics: { x: 1 } }])), 'VALUE_RANGE');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { tag: 'non-ascii-π' }, metrics: { x: 1 } }])), 'VALUE_RANGE');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { tag: 'surrogate\uD800' }, metrics: { x: 1 } }])), 'INPUT_UNSUPPORTED');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { tag: true }, metrics: { x: 1 } }])), 'VALUE_TYPE');
  assert.equal(code(withBucketMetrics([{ bucketId: 'b0', metrics: { x: 1 }, extra: 1 }])), 'FIELD_UNKNOWN');

  // Secrets blocked in bucketId, dimension key, dimension value, and metric key
  for (const secret of ['ghp_123456789012345678901234', 'ghs_abcdefghijklmnopqrstuvwx', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
    assert.equal(code(withBucketMetrics([{ bucketId: secret, metrics: { x: 1 } }])), 'VALUE_RANGE', `bucketId:${secret}`);
    assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { tag: secret }, metrics: { x: 1 } }])), 'VALUE_RANGE', `dimVal:${secret}`);
    assert.equal(code(withBucketMetrics([{ bucketId: 'b0', dimensions: { [secret]: 1 }, metrics: { x: 1 } }])), 'VALUE_RANGE', `dimKey:${secret}`);
    assert.equal(code(withBucketMetrics([{ bucketId: 'b0', metrics: { [secret]: 1 } }])), 'VALUE_RANGE', `metricKey:${secret}`);
  }

  // Custom registered secret blocked via validateBucketMetrics(input, scrubber)
  const customScrubber = new SecretScrubber();
  customScrubber.register('canary-token-9999');
  assert.equal(
    code(validateBucketMetrics([{ bucketId: 'b0', dimensions: { tag: 'canary-token-9999' }, metrics: { x: 1 } }], customScrubber)),
    'VALUE_RANGE',
  );
  assert.equal(
    validateBucketMetrics([{ bucketId: 'b0', dimensions: { tag: 'fp16' }, metrics: { x: 1 } }], customScrubber).ok,
    true,
  );

  // Prototype pollution via JSON string rejected
  for (const protoKey of ['__proto__', 'constructor', 'prototype']) {
    const fixture = evaluationFixture();
    const jsonDim = JSON.stringify(fixture.input.trusted.eligibleEvidence[0]).replace(
      '"reason":null',
      `"reason":null,"bucketMetrics":[{"bucketId":"b0","dimensions":{"${protoKey}":1},"metrics":{"x":1}}]`,
    );
    assert.equal(code(validateDocument(jsonDim, 'Evidence')), 'IDENTIFIER_INVALID', `dim:${protoKey}`);

    const jsonMetric = JSON.stringify(fixture.input.trusted.eligibleEvidence[0]).replace(
      '"reason":null',
      `"reason":null,"bucketMetrics":[{"bucketId":"b0","metrics":{"${protoKey}":1}}]`,
    );
    assert.equal(code(validateDocument(jsonMetric, 'Evidence')), 'IDENTIFIER_INVALID', `metric:${protoKey}`);

    const jsonEntry = JSON.stringify(fixture.input.trusted.eligibleEvidence[0]).replace(
      '"reason":null',
      `"reason":null,"bucketMetrics":[{"bucketId":"b0","metrics":{"x":1},"${protoKey}":1}]`,
    );
    assert.equal(code(validateDocument(jsonEntry, 'Evidence')), 'FIELD_UNKNOWN', `entry:${protoKey}`);
  }
});

test('Evidence.spec.hardwareDiagnostics validates closed enum, numeric bounds, topStallReasons, and rejects exfiltration', () => {
  const withDiagnostics = (hardwareDiagnostics: unknown) => {
    const fixture = evaluationFixture();
    Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { hardwareDiagnostics });
    return validateDocument(fixture.input.trusted.eligibleEvidence[0], 'Evidence');
  };

  // Every closed boundPipeline enum value accepted; optional fields omitted when absent
  assert.deepEqual([...HARDWARE_BOUND_PIPELINES], [
    'hbm', 'l2', 'smem_lds_ub', 'tensor_cube', 'vector_valu', 'host_launch', 'comm', 'unknown',
  ]);
  for (const pipeline of HARDWARE_BOUND_PIPELINES) {
    const parsed = value(withDiagnostics({ boundPipeline: pipeline }));
    const diag = parsed.spec.hardwareDiagnostics!;
    assert.equal(diag.boundPipeline, pipeline);
    assert.equal(Object.getPrototypeOf(diag), null);
    assert.equal(Object.hasOwn(diag, 'rooflineHeadroom'), false);
    assert.equal(Object.hasOwn(diag, 'topStallReasons'), false);
  }

  // Full payload with exact 16 stall reasons and boundary values
  const fullDiag: HardwareDiagnostics = {
    boundPipeline: 'tensor_cube',
    rooflineHeadroom: 1.08,
    achievedSolPct: 92.5,
    arithmeticIntensity: 256.4,
    occupancyPct: 75,
    registerCount: 96,
    sharedMemBytes: 49_152,
    localSpillBytes: 0,
    l2HitPct: 88.2,
    bankConflictPct: 0.5,
    topStallReasons: Array.from({ length: LIMITS.hardwareStallReasons }, (_, i) => ({
      reason: `stall_reason_${i}`,
      pct: i === 0 ? 0 : i === 15 ? 100 : 5.25,
    })),
  };
  const parsedFull = value(withDiagnostics(fullDiag));
  assert.equal(parsedFull.spec.hardwareDiagnostics?.registerCount, 96);
  assert.equal(parsedFull.spec.hardwareDiagnostics?.topStallReasons?.length, 16);
  assert.equal(Object.getPrototypeOf(parsedFull.spec.hardwareDiagnostics?.topStallReasons?.[0]), null);

  // Invalid boundPipeline, missing required field, unknown keys, prototype keys
  assert.equal(code(withDiagnostics({})), 'FIELD_REQUIRED');
  assert.equal(code(withDiagnostics({ boundPipeline: 'dram' })), 'VALUE_ENUM');
  assert.equal(code(withDiagnostics({ boundPipeline: 42 })), 'VALUE_TYPE');
  assert.equal(code(withDiagnostics({ boundPipeline: 'hbm', freeTextNote: 'leaked' })), 'FIELD_UNKNOWN');

  for (const protoKey of ['__proto__', 'constructor', 'prototype']) {
    const fixture = evaluationFixture();
    const jsonWithProto = JSON.stringify(fixture.input.trusted.eligibleEvidence[0]).replace(
      '"reason":null',
      `"reason":null,"hardwareDiagnostics":{"boundPipeline":"hbm","${protoKey}":1}`,
    );
    assert.equal(code(validateDocument(jsonWithProto, 'Evidence')), 'FIELD_UNKNOWN', protoKey);
  }

  // Percentage fields must be in [0, 100]
  for (const pctField of ['achievedSolPct', 'occupancyPct', 'l2HitPct', 'bankConflictPct'] as const) {
    for (const badVal of [-0.01, 100.01, NaN, Infinity, -Infinity]) {
      assert.equal(code(withDiagnostics({ boundPipeline: 'hbm', [pctField]: badVal })), 'VALUE_RANGE', `${pctField}:${badVal}`);
    }
    assert.equal(code(withDiagnostics({ boundPipeline: 'hbm', [pctField]: '50' })), 'VALUE_TYPE', pctField);
    assert.throws(
      () => hardwareDiagnosticsSchema({ boundPipeline: 'hbm', [pctField]: -0 }, '/diag'),
      (err: unknown) => err instanceof Error && err.message === 'VALUE_RANGE',
    );
  }

  // Non-negative float fields
  for (const floatField of ['rooflineHeadroom', 'arithmeticIntensity'] as const) {
    for (const badVal of [-0.001, NaN, Infinity, -Infinity]) {
      assert.equal(code(withDiagnostics({ boundPipeline: 'hbm', [floatField]: badVal })), 'VALUE_RANGE', `${floatField}:${badVal}`);
    }
    assert.throws(
      () => hardwareDiagnosticsSchema({ boundPipeline: 'hbm', [floatField]: -0 }, '/diag'),
      (err: unknown) => err instanceof Error && err.message === 'VALUE_RANGE',
    );
  }

  // Non-negative integer fields
  for (const intField of ['registerCount', 'sharedMemBytes', 'localSpillBytes'] as const) {
    for (const badVal of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(code(withDiagnostics({ boundPipeline: 'hbm', [intField]: badVal })), 'VALUE_RANGE', `${intField}:${badVal}`);
    }
    assert.throws(
      () => hardwareDiagnosticsSchema({ boundPipeline: 'hbm', [intField]: -0 }, '/diag'),
      (err: unknown) => err instanceof Error && err.message === 'VALUE_RANGE',
    );
  }

  // topStallReasons bounds, duplicates, free-text, non-ASCII, lone surrogate, secrets
  assert.equal(
    code(withDiagnostics({
      boundPipeline: 'hbm',
      topStallReasons: Array.from({ length: LIMITS.hardwareStallReasons + 1 }, (_, i) => ({ reason: `r_${i}`, pct: 1 })),
    })),
    'VALUE_RANGE',
  );
  assert.equal(
    code(withDiagnostics({
      boundPipeline: 'hbm',
      topStallReasons: [
        { reason: 'long_scoreboard', pct: 30 },
        { reason: 'long_scoreboard', pct: 20 },
      ],
    })),
    'DUPLICATE_ID',
  );
  for (const badReason of ['free text workload leak', 'stall\nwait', 'stáll', '9leading_digit', 'constructor', '__proto__', 'prototype']) {
    assert.equal(
      code(withDiagnostics({ boundPipeline: 'hbm', topStallReasons: [{ reason: badReason, pct: 10 }] })),
      'IDENTIFIER_INVALID',
      badReason,
    );
  }
  for (const secretReason of ['', 'a'.repeat(LIMITS.hardwareStallReason + 1), 'ghp_123456789012345678901234', 'OPENAI_API_KEY']) {
    assert.equal(
      code(withDiagnostics({ boundPipeline: 'hbm', topStallReasons: [{ reason: secretReason, pct: 10 }] })),
      'VALUE_RANGE',
      secretReason,
    );
  }
  assert.equal(
    code(withDiagnostics({ boundPipeline: 'hbm', topStallReasons: [{ reason: 'stall_\uD800', pct: 10 }] })),
    'INPUT_UNSUPPORTED',
  );
  assert.equal(
    code(withDiagnostics({ boundPipeline: 'hbm', topStallReasons: [{ reason: 'long_scoreboard', pct: 101 }] })),
    'VALUE_RANGE',
  );
  assert.equal(
    code(withDiagnostics({ boundPipeline: 'hbm', topStallReasons: [{ reason: 'long_scoreboard', pct: -1 }] })),
    'VALUE_RANGE',
  );
  assert.equal(
    code(withDiagnostics({ boundPipeline: 'hbm', topStallReasons: [{ reason: 'long_scoreboard', pct: 10, extra: true }] })),
    'FIELD_UNKNOWN',
  );

  // Custom scrubber secret rejected in validateHardwareDiagnostics
  const customScrubber = new SecretScrubber();
  customScrubber.register('secret_stall_canary');
  assert.equal(
    code(validateHardwareDiagnostics({
      boundPipeline: 'hbm',
      topStallReasons: [{ reason: 'secret_stall_canary', pct: 10 }],
    }, customScrubber)),
    'VALUE_RANGE',
  );
  assert.equal(
    validateHardwareDiagnostics({
      boundPipeline: 'hbm',
      topStallReasons: [{ reason: 'long_scoreboard', pct: 42.5 }],
    }, customScrubber).ok,
    true,
  );

  // Legacy canonical digest parity when optional Evidence fields are absent
  const ev1 = evaluationFixture().input.trusted.eligibleEvidence[0]!;
  const parsedEv1 = value(validateDocument(ev1, 'Evidence'));
  assert.equal(canonical(parsedEv1), canonical(ev1));
});

test('evaluateAcceptance and evaluateMetricThresholds enforce bucketScope across aggregate, all_buckets, and targeted bucketId', () => {
  const buckets: readonly BucketMetricEntry[] = [
    {
      bucketId: 'bs1-isl4k',
      dimensions: { bs: 1, isl: 4096 },
      metrics: {
        max_ulp: 0.5,
        token_force_max_delta: 0.01,
        latency_us_p50: 40,
        baseline_latency_us_p50: 50,
        goodput_rps: 120,
        baseline_goodput_rps: 100,
      },
    },
    {
      bucketId: 'bs16-isl8k',
      dimensions: { bs: 16, isl: 8192 },
      metrics: {
        max_ulp: 1,
        token_force_max_delta: 0.02,
        latency_us_p50: 320,
        baseline_latency_us_p50: 400,
        goodput_rps: 900,
        baseline_goodput_rps: 800,
      },
    },
  ];

  // 1. Mixed aggregate + all_buckets + targeted { bucketId } (bounds and comparative) passes cleanly
  const passingRules: readonly MetricThresholdRule[] = [
    { kind: 'bounds', metric: 'tflops', min: 400 },
    { kind: 'bounds', metric: 'tflops', min: 400, bucketScope: 'aggregate' },
    { kind: 'bounds', metric: 'max_ulp', min: 0, max: 1, bucketScope: 'all_buckets' },
    { kind: 'bounds', metric: 'token_force_max_delta', max: 0.02, bucketScope: 'all_buckets' },
    {
      kind: 'comparative',
      metric: 'latency_us_p50',
      baselineMetric: 'baseline_latency_us_p50',
      operator: 'max_ratio',
      threshold: 0.85,
      bucketScope: 'all_buckets',
    },
    {
      kind: 'comparative',
      metric: 'goodput_rps',
      baselineMetric: 'baseline_goodput_rps',
      operator: 'min_ratio',
      threshold: 1.1,
      bucketScope: 'all_buckets',
    },
    {
      kind: 'comparative',
      metric: 'latency_us_p50',
      baselineMetric: 'baseline_latency_us_p50',
      operator: 'max_delta',
      threshold: -10,
      bucketScope: { bucketId: 'bs1-isl4k' },
    },
    { kind: 'bounds', metric: 'latency_us_p50', max: 350, bucketScope: { bucketId: 'bs16-isl8k' } },
  ];
  const passing = makeHardwareEvaluation({
    metricThresholds: passingRules,
    metrics: { tflops: 420 },
    bucketMetrics: buckets,
    hardwareDiagnostics: { boundPipeline: 'hbm', rooflineHeadroom: 1.12, occupancyPct: 68 },
  });
  const evalPass = value(evaluateAcceptance(passing.input, passing.artifacts));
  assert.equal(evalPass.spec.satisfied, true);
  assert.equal(evalPass.spec.required[0]!.status, 'passed');
  const runPass = value(constructRunResult({
    trusted: { ...passing.input.trusted, usage: [], externalEffects: 'none', noChange: null },
    candidate: { status: 'completed', checks: passing.input.claims, memory: { status: 'not_requested', reason: null } },
  }, passing.artifacts));
  assert.equal(runPass.spec.status, 'completed');

  // 2. Bucket-scoped rules ONLY pass even when aggregate Evidence.spec.metrics is omitted
  const bucketOnlyPass = makeHardwareEvaluation({
    metricThresholds: [
      { kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' },
      { kind: 'bounds', metric: 'latency_us_p50', max: 50, bucketScope: { bucketId: 'bs1-isl4k' } },
    ],
    bucketMetrics: buckets,
  });
  assert.equal(value(evaluateAcceptance(bucketOnlyPass.input, bucketOnlyPass.artifacts)).spec.satisfied, true);

  // 3. Targeted { bucketId } passes even when a DIFFERENT bucket would violate the rule
  const targetedPass = makeHardwareEvaluation({
    metricThresholds: [
      { kind: 'bounds', metric: 'latency_us_p50', max: 50, bucketScope: { bucketId: 'bs1-isl4k' } },
    ],
    bucketMetrics: buckets, // bs16-isl8k has latency_us_p50 = 320 > 50, but scope is bs1-isl4k
  });
  assert.equal(value(evaluateAcceptance(targetedPass.input, targetedPass.artifacts)).spec.satisfied, true);

  // 4. All fail-closed bucketScope rejection scenarios
  const failingCases: {
    readonly label: string;
    readonly rules: readonly MetricThresholdRule[];
    readonly metrics?: Record<string, number | string | boolean>;
    readonly bucketMetrics?: readonly BucketMetricEntry[];
  }[] = [
    {
      label: 'all_buckets missing bucketMetrics',
      rules: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' }],
      metrics: { max_ulp: 0 },
    },
    {
      label: 'all_buckets single bucket violates bounds',
      rules: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' }],
      bucketMetrics: [
        { bucketId: 'bs1-isl4k', metrics: { max_ulp: 0.5 } },
        { bucketId: 'bs16-isl8k', metrics: { max_ulp: 1.5 } },
      ],
    },
    {
      label: 'all_buckets single bucket missing metric',
      rules: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'all_buckets' }],
      metrics: { max_ulp: 0 },
      bucketMetrics: [
        { bucketId: 'bs1-isl4k', metrics: { max_ulp: 0.5 } },
        { bucketId: 'bs16-isl8k', metrics: { latency_us_p50: 100 } },
      ],
    },
    {
      label: 'all_buckets comparative fails on second bucket',
      rules: [{
        kind: 'comparative',
        metric: 'latency_us_p50',
        baselineMetric: 'baseline_latency_us_p50',
        operator: 'max_ratio',
        threshold: 0.85,
        bucketScope: 'all_buckets',
      }],
      bucketMetrics: [
        { bucketId: 'bs1-isl4k', metrics: { latency_us_p50: 40, baseline_latency_us_p50: 50 } },
        { bucketId: 'bs16-isl8k', metrics: { latency_us_p50: 360, baseline_latency_us_p50: 400 } },
      ],
    },
    {
      label: 'all_buckets comparative missing baselineMetric in bucket does NOT fall back to aggregate',
      rules: [{
        kind: 'comparative',
        metric: 'latency_us_p50',
        baselineMetric: 'baseline_latency_us_p50',
        operator: 'max_delta',
        threshold: 0,
        bucketScope: 'all_buckets',
      }],
      metrics: { latency_us_p50: 40, baseline_latency_us_p50: 500 },
      bucketMetrics: [
        { bucketId: 'bs1-isl4k', metrics: { latency_us_p50: 40 } },
      ],
    },
    {
      label: 'all_buckets comparative non-positive baseline fails ratio check',
      rules: [{
        kind: 'comparative',
        metric: 'goodput_rps',
        baselineMetric: 'baseline_goodput_rps',
        operator: 'min_ratio',
        threshold: 1.0,
        bucketScope: 'all_buckets',
      }],
      bucketMetrics: [
        { bucketId: 'bs1-isl4k', metrics: { goodput_rps: 100, baseline_goodput_rps: 0 } },
      ],
    },
    {
      label: 'targeted bucketId missing bucketMetrics',
      rules: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: { bucketId: 'bs1-isl4k' } }],
      metrics: { max_ulp: 0 },
    },
    {
      label: 'targeted bucketId not found in bucketMetrics',
      rules: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: { bucketId: 'bs32-isl16k' } }],
      bucketMetrics: buckets,
    },
    {
      label: 'targeted bucketId fails bounds',
      rules: [{ kind: 'bounds', metric: 'latency_us_p50', max: 30, bucketScope: { bucketId: 'bs1-isl4k' } }],
      bucketMetrics: buckets,
    },
    {
      label: 'targeted bucketId comparative fails max_delta',
      rules: [{
        kind: 'comparative',
        metric: 'latency_us_p50',
        baselineMetric: 'baseline_latency_us_p50',
        operator: 'max_delta',
        threshold: -15,
        bucketScope: { bucketId: 'bs1-isl4k' },
      }],
      bucketMetrics: buckets, // 40 - 50 = -10 > -15 -> fail
    },
    {
      label: 'explicit aggregate fails when aggregate metrics missing even if bucketMetrics has key',
      rules: [{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: 'aggregate' }],
      bucketMetrics: buckets,
    },
  ];

  for (const tc of failingCases) {
    const f = makeHardwareEvaluation({
      metricThresholds: tc.rules,
      ...(tc.metrics !== undefined ? { metrics: tc.metrics } : {}),
      ...(tc.bucketMetrics !== undefined ? { bucketMetrics: tc.bucketMetrics } : {}),
    });
    const res = value(evaluateAcceptance(f.input, f.artifacts));
    assert.equal(res.spec.satisfied, false, tc.label);
    assert.equal(res.spec.required[0]!.status, 'blocked', tc.label);
    assert.equal(res.spec.required[0]!.reason, 'metric_threshold_failed', tc.label);
    assert.equal(res.spec.diagnostics[0]!.code, 'METRIC_THRESHOLD_FAILED', tc.label);
    assert.equal(validateDocument(res, 'VerificationResult').ok, true, tc.label);
    assert.equal(code(constructRunResult({
      trusted: { ...f.input.trusted, usage: [], externalEffects: 'none', noChange: null },
      candidate: { status: 'completed', checks: f.input.claims, memory: { status: 'not_requested', reason: null } },
    }, f.artifacts)), 'RUN_ACCEPTANCE_REQUIRED', tc.label);
  }

  // Direct evaluateMetricThresholds helper checks (including empty bucketMetrics array fail-closed)
  const allBucketsRule: MetricThresholdRule = {
    kind: 'bounds',
    metric: 'max_ulp',
    max: 1,
    bucketScope: 'all_buckets' as MetricBucketScope,
  };
  assert.equal(evaluateMetricThresholds([allBucketsRule], { max_ulp: 0 }, []), false);
  assert.equal(evaluateMetricThresholds([allBucketsRule], undefined, buckets), true);
  assert.equal(
    evaluateMetricThresholds([{ kind: 'bounds', metric: 'max_ulp', max: 1, bucketScope: { bucketId: 'bs1-isl4k' } }], undefined, []),
    false,
  );
  assert.equal(evaluateMetricThresholds([], undefined, undefined), true);
});
