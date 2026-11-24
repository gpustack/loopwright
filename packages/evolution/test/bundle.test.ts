import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SecretScrubber,
  type BucketMetricEntry,
  type Digest,
  type HardwareDiagnostics,
  type HardwareProvenance,
} from '@loopwright/core';
import {
  signBenchmarkVerdict,
  verifyBenchmarkVerdictSignature,
  type BenchmarkOutputArtifact,
  type BenchmarkVerdict,
  type SignedBenchmarkVerdictReceipt,
} from '@loopwright/hardware-runner';
import {
  EVOLUTION_BUNDLE_KIND,
  EVOLUTION_BUNDLE_VERSION,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_LAYOUT_VERSION,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  exportEvolutionBundle,
  verifyEvolutionBundle,
} from '../src/bundle.js';
import { parseDispatchManifestV1, parseEvolutionCampaignDocument } from '../src/schema.js';
import { EvolutionCampaignStore } from '../src/store.js';
import {
  EvolutionError,
  type DispatchManifestV1,
  type EvolutionBundleManifestV1,
  type EvolutionErrorCode,
} from '../src/types.js';

const TEST_HMAC_SECRET = 'test-bundle-hmac-signing-secret-2026';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function makeDigest(seed: string): Digest {
  return { algorithm: 'sha256', hex: sha256Hex(seed) };
}

async function assertEvolutionErrorAsync(
  fn: () => Promise<unknown>,
  expectedCode: EvolutionErrorCode,
): Promise<EvolutionError> {
  try {
    await fn();
  } catch (err: unknown) {
    assert.ok(
      err instanceof EvolutionError,
      `expected EvolutionError(${expectedCode}), got ${String(err)}`,
    );
    assert.equal(err.code, expectedCode, `expected code ${expectedCode}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected EvolutionError(${expectedCode}) to be thrown`);
}

function collectRelativeFilesRecursive(rootDir: string, prefix = ''): readonly string[] {
  const entries = readdirSync(join(rootDir, prefix), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectRelativeFilesRecursive(rootDir, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const SINGLE_TARGET_CAMPAIGN_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: flash-decode-sm90a
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: single-target
    heldOutWorkloadId: decode-h100-holdout
  population:
    islands: 2
    migrationIntervalGenerations: 4
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, l2, smem_lds_ub, tensor_cube]
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.5
      full_rewrite: 0.3
      crossover: 0.2
    maxCrossoversPerPrompt: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 10
    maxEvaluations: 40
    maxConcurrentEvaluations: 2
    scratchpadIntervalGenerations: 5
  export:
    format: oci-layout
    outputDir: .loopwright-out/bundles/flash-decode-sm90a
`;

const PORTFOLIO_CAMPAIGN_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: flash-decode-portfolio
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: specialist-then-portfolio
    specialistBuckets:
      - id: bs1-isl4k
        heldOutWorkloadId: decode-bs1-4k
      - id: bs16-isl8k
        heldOutWorkloadId: decode-bs16-8k
    portfolioHeldOutWorkloadId: decode-portfolio-holdout
  population:
    islands: 2
    migrationIntervalGenerations: 4
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, l2, smem_lds_ub, tensor_cube]
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.5
      full_rewrite: 0.3
      crossover: 0.2
    maxCrossoversPerPrompt: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 10
    maxEvaluations: 40
    maxConcurrentEvaluations: 2
    scratchpadIntervalGenerations: 5
`;

interface ReceiptFixtureOptions {
  readonly lockHash: Digest;
  readonly operationId: string;
  readonly status?: 'approved' | 'denied' | 'expired';
  readonly reason?: string | null;
  readonly detail?: string | null;
  readonly probeKind?: 'physical' | 'synthetic_fixture';
  readonly accelerator?: string;
  readonly driverVersion?: string;
  readonly workloadDigest?: Digest;
  readonly outputArtifacts?: readonly BenchmarkOutputArtifact[];
  readonly metrics?: Readonly<Record<string, number>>;
  readonly signingSecret?: string;
  readonly prettyPrint?: boolean;
  readonly extraFields?: Readonly<Record<string, unknown>>;
}

function makeSignedReceiptBytes(opts: ReceiptFixtureOptions): {
  readonly receipt: SignedBenchmarkVerdictReceipt;
  readonly rawBytes: Buffer;
  readonly provenance: HardwareProvenance;
} {
  const provenance: HardwareProvenance = {
    targetCellId: 'cuda-h100-whole',
    probeKind: opts.probeKind ?? 'physical',
    vendor: 'nvidia',
    deviceModel: 'NVIDIA H100 80GB HBM3',
    accelerator: opts.accelerator ?? 'sm_90a',
    isolationMode: 'whole_device',
    deviceCount: 1,
    driverVersion: opts.driverVersion ?? '560.35.03',
    runtimeVersion: 'cuda-12.6',
    topology: 'single_gpu',
    workloadDigest: opts.workloadDigest ?? makeDigest('workload-default'),
    clockLockMode: 'locked',
  };

  const status = opts.status ?? 'approved';
  const verdictBase: Record<string, unknown> = {
    version: 1,
    kind: 'benchmark_verdict',
    storeId: 'store-evo-01',
    runId: 'run-evo-01',
    lockHash: opts.lockHash,
    operationId: opts.operationId,
    dispatchId: `disp-${opts.operationId}`,
    dispatchGeneration: 1,
    gateId: 'benchmark-gate',
    checkId: 'hw-bench',
    candidateDigest: sha256Hex(`cand-${opts.operationId}`),
    status,
    reason: opts.reason !== undefined ? opts.reason : (status === 'approved' ? null : 'METRIC_THRESHOLD_FAILED'),
    expiresAtMs: '1900000000000',
    preemptionCount: 0,
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
    metrics: opts.metrics ?? { latency_us_p50: 42.5, goodput_rps: 2400 },
    hardwareProvenance: provenance,
    ...(opts.outputArtifacts !== undefined ? { outputArtifacts: opts.outputArtifacts } : {}),
    ...(opts.extraFields ?? {}),
  };

  const signature = signBenchmarkVerdict(
    opts.signingSecret ?? TEST_HMAC_SECRET,
    verdictBase as unknown as BenchmarkVerdict,
  );
  const receipt = {
    ...verdictBase,
    signature,
  } as unknown as SignedBenchmarkVerdictReceipt;

  // Optionally pretty-print with non-canonical key order and whitespace to verify unmodified receipt bytes are preserved!
  const rawJson = opts.prettyPrint
    ? `${JSON.stringify(receipt, null, 2)}\n`
    : JSON.stringify(receipt);
  return {
    receipt,
    rawBytes: Buffer.from(rawJson, 'utf8'),
    provenance,
  };
}

async function seedSingleTargetCampaign(
  campaignRoot: string,
  options: {
    readonly probeKind?: 'physical' | 'synthetic_fixture';
    readonly receiptStatus?: 'approved' | 'denied';
    readonly missingReceipt?: boolean;
    readonly receiptDetail?: string;
    readonly policyJsonContent?: string;
  } = {},
): Promise<{
  readonly store: EvolutionCampaignStore;
  readonly campaignId: string;
  readonly lockHash: Digest;
  readonly cubinBytes: Buffer;
  readonly cubinDigest: Digest;
  readonly policyDigest: Digest;
  readonly rawReceiptBytes: Buffer;
  readonly dispatchManifest: DispatchManifestV1;
}> {
  const store = await EvolutionCampaignStore.open({ campaignRoot });
  const lease = await store.acquireLease('bundle-test-owner');
  const manifest = parseEvolutionCampaignDocument(SINGLE_TARGET_CAMPAIGN_YAML);
  const lockHash = makeDigest('lock-single-target');
  const campaignId = 'camp-bundle-1';

  await store.createCampaign(lease, {
    campaignId,
    manifest,
    manifestDigest: makeDigest(SINGLE_TARGET_CAMPAIGN_YAML),
    baseRevision: 'a'.repeat(40),
    lockHash,
    modelIds: ['claude-sonnet-4-6'],
  });
  await store.updateCampaignProgress(lease, { campaignId, status: 'completed', currentGeneration: 4 });

  const islands = await store.listIslands(campaignId);
  const team0 = islands[0]!.activeTeamConfigId;

  const cubinBytes = Buffer.from('\x7fELF\x02\x01\x01\x00FLASH_DECODE_SM90A_CUBIN_PAYLOAD_V1', 'binary');
  const cubinCas = await store.writeCasBlob(cubinBytes);
  const policyBytes = Buffer.from(
    options.policyJsonContent ?? '{"tileM":128,"tileN":64,"warps":8}\n',
    'utf8',
  );
  const policyCas = await store.writeCasBlob(policyBytes);

  const outputArtifacts: readonly BenchmarkOutputArtifact[] = [
    {
      name: 'flash_decode_sm90a.cubin',
      digest: cubinCas.digest,
      byteLength: cubinCas.byteLength,
      mediaType: 'application/x-nvidia-cubin',
    },
    {
      name: 'policy.json',
      digest: policyCas.digest,
      byteLength: policyCas.byteLength,
      mediaType: 'application/json',
    },
  ];

  const bucketMetrics: readonly BucketMetricEntry[] = [
    {
      bucketId: 'bs1-isl4k',
      dimensions: { batch: 1, isl: 4096, dtype: 'bf16' },
      metrics: { latency_us_p50: 42.5, goodput_rps: 2400, max_ulp: 0.5 },
    },
    {
      bucketId: 'bs16-isl8k',
      dimensions: { batch: 16, isl: 8192, dtype: 'bf16' },
      metrics: { latency_us_p50: 95.0, goodput_rps: 5100, max_ulp: 0.5 },
    },
  ];

  const hardwareDiagnostics: HardwareDiagnostics = {
    boundPipeline: 'tensor_cube',
    rooflineHeadroom: 1.12,
    achievedSolPct: 84.5,
    occupancyPct: 75,
    localSpillBytes: 0,
  };

  const { rawBytes: rawReceiptBytes, provenance } = makeSignedReceiptBytes({
    lockHash,
    operationId: 'op-ind-win-1',
    status: options.receiptStatus ?? 'approved',
    probeKind: options.probeKind ?? 'physical',
    ...(options.receiptDetail !== undefined ? { detail: options.receiptDetail } : {}),
    outputArtifacts,
    metrics: { latency_us_p50: 42.5, goodput_rps: 2400 },
    prettyPrint: true,
  });

  const receiptCas = await store.writeCasBlob(rawReceiptBytes);

  await store.recordIndividual(lease, {
    individualId: 'ind-win-1',
    campaignId,
    islandId: 0,
    generation: 4,
    bucketId: null,
    teamConfigId: team0,
    modelId: 'claude-sonnet-4-6',
    trackId: 'cute',
    mutationKind: 'full_rewrite',
    status: 'passed',
    failureReason: null,
    nicheKey: 'bound_pipeline=tensor_cube',
    paretoRank: 1,
    crowdingDistance: Number.POSITIVE_INFINITY,
    scalarFitness: 0.96,
    codeSliceCasDigest: makeDigest('code-win-1'),
    evidenceDigest: makeDigest('ev-win-1'),
    verdictReceiptCasDigest: options.missingReceipt ? null : receiptCas.digest,
    outputArtifacts: outputArtifacts.map(a => ({
      name: `.loopwright-verifier/check.hw-bench/${a.name}`,
      digest: a.digest,
      byteLength: a.byteLength,
      uri: `cas://sha256/${a.digest.hex}`,
      mediaType: a.mediaType ?? null,
    })),
    metrics: { latency_us_p50: 42.5, goodput_rps: 2400 },
    bucketMetrics,
    hardwareDiagnostics,
    hardwareProvenance: provenance,
  });

  const dispatchManifest: DispatchManifestV1 = {
    version: 1,
    fallback: 'baseline',
    rules: [
      {
        bucketId: 'bs1-isl4k',
        dimensionBounds: { batch: { min: 1, max: 4 }, isl: { min: 1, max: 4096 } },
        dtypes: ['bf16', 'fp16'],
        alignmentBytes: 16,
        blobDigest: cubinCas.digest,
        blobPath: `blobs/sha256/${cubinCas.digest.hex}`,
        entrypoint: 'flash_decode_sm90a_bs1',
      },
      {
        bucketId: 'bs16-isl8k',
        dimensionBounds: { batch: { min: 5, max: 32 }, isl: { min: 4097, max: 16384 } },
        dtypes: ['bf16'],
        alignmentBytes: 16,
        blobDigest: cubinCas.digest,
        blobPath: `blobs/sha256/${cubinCas.digest.hex}`,
        entrypoint: 'flash_decode_sm90a_bs16',
      },
    ],
  };

  return {
    store,
    campaignId,
    lockHash,
    cubinBytes,
    cubinDigest: cubinCas.digest,
    policyDigest: policyCas.digest,
    rawReceiptBytes,
    dispatchManifest,
  };
}

test('bundle (dir): repeated exports produce byte-identical manifest, dispatch-manifest, unmodified HMAC receipt, and verified blobs', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-dir-'));
  try {
    const campaignRoot = join(tempDir, 'campaign');
    const seeded = await seedSingleTargetCampaign(campaignRoot);
    try {
      const outA = join(tempDir, 'out-dir-a');
      const outB = join(tempDir, 'out-dir-b');
      const modelDigest = makeDigest('model-llama3-70b');

      const resA = await exportEvolutionBundle({
        store: seeded.store,
        campaignId: seeded.campaignId,
        outputDir: outA,
        format: 'dir',
        dispatchManifest: seeded.dispatchManifest,
        receiptSigningSecret: TEST_HMAC_SECRET,
        driverConstraint: '>=560.35',
        modelDigest,
        parallelismTags: ['tp4', 'pp1'],
      });

      const resB = await exportEvolutionBundle({
        store: seeded.store,
        campaignId: seeded.campaignId,
        outputDir: outB,
        format: 'dir',
        dispatchManifest: seeded.dispatchManifest,
        receiptSigningSecret: TEST_HMAC_SECRET,
        driverConstraint: '>=560.35',
        modelDigest,
        parallelismTags: ['pp1', 'tp4'], // Reversed order must still yield identical canonical bytes
      });

      assert.equal(resA.format, 'dir');
      assert.equal(resA.ociIndexDigest, undefined);
      assert.equal(resA.manifestDigest.hex, resB.manifestDigest.hex);
      assert.equal(resA.dispatchManifestDigest.hex, resB.dispatchManifestDigest.hex);
      assert.deepEqual(resA.exportedIndividualIds, ['ind-win-1']);
      assert.equal(resA.blobCount, 2);

      // Compare full directory trees byte-for-byte
      const filesA = collectRelativeFilesRecursive(outA);
      const filesB = collectRelativeFilesRecursive(outB);
      assert.deepEqual(filesA, filesB);
      assert.equal(filesA.includes('oci-layout'), false);
      assert.equal(filesA.includes('index.json'), false);

      for (const rel of filesA) {
        assert.deepEqual(readFileSync(join(outA, rel)), readFileSync(join(outB, rel)), `byte mismatch on ${rel}`);
      }

      // Check manifest.json structure and member digests
      const manifestRaw = readFileSync(join(outA, 'manifest.json'));
      assert.equal(sha256Hex(manifestRaw), resA.manifestDigest.hex);
      const bundleManifest = JSON.parse(manifestRaw.toString('utf8')) as EvolutionBundleManifestV1;
      assert.equal(bundleManifest.kind, EVOLUTION_BUNDLE_KIND);
      assert.equal(bundleManifest.version, EVOLUTION_BUNDLE_VERSION);
      assert.equal(bundleManifest.compatibility.accelerator, 'sm_90a');
      assert.equal(bundleManifest.compatibility.isolationMode, 'whole_device');
      assert.equal(bundleManifest.compatibility.deviceCount, 1);
      assert.equal(bundleManifest.compatibility.driverVersion, '560.35.03');
      assert.equal(bundleManifest.compatibility.driverConstraint, '>=560.35');
      assert.equal(bundleManifest.compatibility.runtimeVersion, 'cuda-12.6');
      assert.equal(bundleManifest.compatibility.topology, 'single_gpu');
      assert.equal(bundleManifest.compatibility.modelDigest?.hex, modelDigest.hex);
      assert.deepEqual(bundleManifest.compatibility.parallelismTags, ['pp1', 'tp4']);
      assert.equal(bundleManifest.lineage.campaignId, seeded.campaignId);
      assert.deepEqual(bundleManifest.lineage.individualIds, ['ind-win-1']);
      assert.equal(bundleManifest.lineage.baseRevision, 'a'.repeat(40));
      assert.equal(bundleManifest.lineage.lockHash.hex, seeded.lockHash.hex);
      assert.equal(bundleManifest.paretoSummary.length, 1);
      assert.equal(bundleManifest.paretoSummary[0]!.paretoRank, 1);
      assert.equal(bundleManifest.paretoSummary[0]!.bucketMetrics?.length, 2);

      // Check dispatch-manifest.json parses cleanly and mandates fallback: 'baseline'
      const dispatchRaw = readFileSync(join(outA, 'dispatch-manifest.json'));
      assert.equal(sha256Hex(dispatchRaw), resA.dispatchManifestDigest.hex);
      const parsedDispatch = parseDispatchManifestV1(dispatchRaw);
      assert.equal(parsedDispatch.version, 1);
      assert.equal(parsedDispatch.fallback, 'baseline');
      assert.equal(parsedDispatch.rules.length, 2);

      // Check receipt is byte-for-byte UNMODIFIED from CAS and passes HMAC verification
      const receiptBytesOnDisk = readFileSync(join(outA, 'receipts', 'ind-win-1.verdict.json'));
      assert.deepEqual(receiptBytesOnDisk, seeded.rawReceiptBytes);
      const parsedReceipt = JSON.parse(receiptBytesOnDisk.toString('utf8')) as SignedBenchmarkVerdictReceipt;
      assert.equal(
        verifyBenchmarkVerdictSignature(
          TEST_HMAC_SECRET,
          parsedReceipt as unknown as Record<string, unknown>,
          parsedReceipt.signature,
        ),
        true,
      );

      // Check .cubin blob matches byte-for-byte
      const exportedCubin = readFileSync(join(outA, 'blobs', 'sha256', seeded.cubinDigest.hex));
      assert.deepEqual(exportedCubin, seeded.cubinBytes);

      // Re-exporting over an existing outputDir atomically succeeds and leaves zero staging temp dirs
      const resOverwrite = await exportEvolutionBundle({
        store: seeded.store,
        campaignId: seeded.campaignId,
        outputDir: outA,
        format: 'dir',
        dispatchManifest: seeded.dispatchManifest,
        receiptSigningSecret: TEST_HMAC_SECRET,
        driverConstraint: '>=560.35',
        modelDigest,
        parallelismTags: ['tp4', 'pp1'],
      });
      assert.equal(resOverwrite.manifestDigest.hex, resA.manifestDigest.hex);
      const siblings = readdirSync(tempDir).filter(name => name.startsWith('.evolution-bundle-'));
      assert.deepEqual(siblings, []);

      // verifyEvolutionBundle passes on exported dir bundle
      const verified = await verifyEvolutionBundle({
        bundleDir: outA,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      assert.equal(verified.format, 'dir');
      assert.equal(verified.manifestDigest.hex, resA.manifestDigest.hex);
      assert.equal(verified.dispatchManifestDigest.hex, resA.dispatchManifestDigest.hex);
      assert.equal(verified.receiptCount, 1);
      assert.equal(verified.blobCount, 2);
    } finally {
      chmodSync(join(campaignRoot, 'cas', 'sha256'), 0o700);
      await seeded.store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle (oci-layout): emits valid byte-identical OCI Image Layout (oci-layout, index.json, OCI manifest, layers) and auto-synthesizes dispatch-manifest', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-oci-'));
  try {
    const campaignRoot = join(tempDir, 'campaign');
    const seeded = await seedSingleTargetCampaign(campaignRoot);
    try {
      const outA = join(tempDir, 'out-oci-a');
      const outB = join(tempDir, 'out-oci-b');

      // Omit explicit dispatchManifest and format (should pick up campaign.spec.export.format === 'oci-layout')
      const resA = await exportEvolutionBundle({
        store: seeded.store,
        campaignId: seeded.campaignId,
        outputDir: outA,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      const resB = await exportEvolutionBundle({
        store: seeded.store,
        campaignId: seeded.campaignId,
        outputDir: outB,
        format: 'oci-layout',
        receiptSigningSecret: TEST_HMAC_SECRET,
      });

      assert.equal(resA.format, 'oci-layout');
      assert.ok(resA.ociIndexDigest !== undefined);
      assert.equal(resA.ociIndexDigest.hex, resB.ociIndexDigest?.hex);
      assert.equal(resA.manifestDigest.hex, resB.manifestDigest.hex);
      assert.equal(resA.dispatchManifestDigest.hex, resB.dispatchManifestDigest.hex);

      const filesA = collectRelativeFilesRecursive(outA);
      const filesB = collectRelativeFilesRecursive(outB);
      assert.deepEqual(filesA, filesB);
      for (const rel of filesA) {
        assert.deepEqual(readFileSync(join(outA, rel)), readFileSync(join(outB, rel)), `OCI byte mismatch on ${rel}`);
      }

      // Verify oci-layout file
      const ociLayoutRaw = readFileSync(join(outA, 'oci-layout'), 'utf8');
      assert.deepEqual(JSON.parse(ociLayoutRaw), { imageLayoutVersion: OCI_IMAGE_LAYOUT_VERSION });

      // Verify index.json and referenced OCI manifest blob
      const indexRaw = readFileSync(join(outA, 'index.json'));
      assert.equal(sha256Hex(indexRaw), resA.ociIndexDigest.hex);
      const indexDoc = JSON.parse(indexRaw.toString('utf8')) as {
        schemaVersion: number;
        mediaType: string;
        manifests: Array<{ mediaType: string; digest: string; size: number }>;
      };
      assert.equal(indexDoc.schemaVersion, 2);
      assert.equal(indexDoc.mediaType, OCI_IMAGE_INDEX_MEDIA_TYPE);
      assert.equal(indexDoc.manifests.length, 1);

      const manifestDesc = indexDoc.manifests[0]!;
      assert.equal(manifestDesc.mediaType, OCI_IMAGE_MANIFEST_MEDIA_TYPE);
      assert.ok(manifestDesc.digest.startsWith('sha256:'));
      const ociManifestHex = manifestDesc.digest.slice(7);
      const ociManifestBytes = readFileSync(join(outA, 'blobs', 'sha256', ociManifestHex));
      assert.equal(ociManifestBytes.byteLength, manifestDesc.size);
      assert.equal(sha256Hex(ociManifestBytes), ociManifestHex);

      const ociManifest = JSON.parse(ociManifestBytes.toString('utf8')) as {
        schemaVersion: number;
        mediaType: string;
        config: { digest: string; size: number };
        layers: Array<{ digest: string; size: number; annotations?: Record<string, string> }>;
      };
      assert.equal(ociManifest.schemaVersion, 2);
      assert.equal(ociManifest.mediaType, OCI_IMAGE_MANIFEST_MEDIA_TYPE);

      // Every layer descriptor must match an existing blob under blobs/sha256/<hex> with exact digest + size
      const layerTitles = ociManifest.layers.map(l => l.annotations?.['org.opencontainers.image.title']);
      assert.ok(layerTitles.includes('manifest.json'));
      assert.ok(layerTitles.includes('dispatch-manifest.json'));
      assert.ok(layerTitles.includes('receipts/ind-win-1.verdict.json'));
      assert.ok(layerTitles.includes(`blobs/sha256/${seeded.cubinDigest.hex}`));
      assert.ok(layerTitles.includes(`blobs/sha256/${seeded.policyDigest.hex}`));

      for (const layer of ociManifest.layers) {
        const hex = layer.digest.slice(7);
        const blobBytes = readFileSync(join(outA, 'blobs', 'sha256', hex));
        assert.equal(blobBytes.byteLength, layer.size);
        assert.equal(sha256Hex(blobBytes), hex);
      }

      // Auto-synthesized dispatch manifest must be valid with fallback: 'baseline'
      const autoDispatch = parseDispatchManifestV1(readFileSync(join(outA, 'dispatch-manifest.json')));
      assert.equal(autoDispatch.fallback, 'baseline');
      assert.equal(autoDispatch.rules.length, 2);
      assert.equal(autoDispatch.rules[0]!.bucketId, 'bs1-isl4k');
      assert.equal(autoDispatch.rules[1]!.bucketId, 'bs16-isl8k');

      // Full bundle verification passes
      const verified = await verifyEvolutionBundle({
        bundleDir: outA,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      assert.equal(verified.format, 'oci-layout');
      assert.equal(verified.ociIndexDigest?.hex, resA.ociIndexDigest.hex);

      // Tampering with 1 byte of the exported .cubin blob in the OCI bundle fails verifyEvolutionBundle
      const exportedCubinPath = join(outA, 'blobs', 'sha256', seeded.cubinDigest.hex);
      const tampered = Buffer.from(readFileSync(exportedCubinPath));
      tampered[0] = tampered[0]! ^ 0xff;
      writeFileSync(exportedCubinPath, tampered);
      await assertEvolutionErrorAsync(
        () => verifyEvolutionBundle({ bundleDir: outA, receiptSigningSecret: TEST_HMAC_SECRET }),
        'ARTIFACT_INVALID',
      );
    } finally {
      chmodSync(join(campaignRoot, 'cas', 'sha256'), 0o700);
      await seeded.store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle: refuses missing receipt, denied receipt, synthetic_fixture without opt-in, and forged HMAC with EXPORT_UNVERIFIED_FORBIDDEN; allows synthetic_fixture with allowSyntheticProbe: true', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-unverified-'));
  try {
    // 1. Missing hardware_execution receipt
    const missingRoot = join(tempDir, 'camp-missing');
    const seededMissing = await seedSingleTargetCampaign(missingRoot, { missingReceipt: true });
    try {
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededMissing.store,
          campaignId: seededMissing.campaignId,
          outputDir: join(tempDir, 'out-missing'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );
    } finally {
      chmodSync(join(missingRoot, 'cas', 'sha256'), 0o700);
      await seededMissing.store.close();
    }

    // 2. Denied receipt status
    const deniedRoot = join(tempDir, 'camp-denied');
    const seededDenied = await seedSingleTargetCampaign(deniedRoot, { receiptStatus: 'denied' });
    try {
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededDenied.store,
          campaignId: seededDenied.campaignId,
          outputDir: join(tempDir, 'out-denied'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );
    } finally {
      chmodSync(join(deniedRoot, 'cas', 'sha256'), 0o700);
      await seededDenied.store.close();
    }

    // 3. synthetic_fixture without allowSyntheticProbe -> refused; with allowSyntheticProbe: true -> succeeds
    const synthRoot = join(tempDir, 'camp-synth');
    const seededSynth = await seedSingleTargetCampaign(synthRoot, { probeKind: 'synthetic_fixture' });
    try {
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededSynth.store,
          campaignId: seededSynth.campaignId,
          outputDir: join(tempDir, 'out-synth-denied'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );

      const synthOut = join(tempDir, 'out-synth-ok');
      const okRes = await exportEvolutionBundle({
        store: seededSynth.store,
        campaignId: seededSynth.campaignId,
        outputDir: synthOut,
        format: 'dir',
        allowSyntheticProbe: true,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      assert.equal(okRes.format, 'dir');
      assert.deepEqual(okRes.exportedIndividualIds, ['ind-win-1']);

      // verifyEvolutionBundle also refuses synthetic_fixture unless allowSyntheticProbe: true
      await assertEvolutionErrorAsync(
        () => verifyEvolutionBundle({ bundleDir: synthOut, receiptSigningSecret: TEST_HMAC_SECRET }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );
      const verifiedSynth = await verifyEvolutionBundle({
        bundleDir: synthOut,
        allowSyntheticProbe: true,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      assert.equal(verifiedSynth.receiptCount, 1);
    } finally {
      chmodSync(join(synthRoot, 'cas', 'sha256'), 0o700);
      await seededSynth.store.close();
    }

    // 4. Tampered / wrong HMAC secret or custom verifier callback returning false -> EXPORT_UNVERIFIED_FORBIDDEN
    const hmacRoot = join(tempDir, 'camp-hmac');
    const seededHmac = await seedSingleTargetCampaign(hmacRoot);
    try {
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededHmac.store,
          campaignId: seededHmac.campaignId,
          outputDir: join(tempDir, 'out-bad-hmac'),
          receiptSigningSecret: 'wrong-secret-key-for-verification',
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );

      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededHmac.store,
          campaignId: seededHmac.campaignId,
          outputDir: join(tempDir, 'out-bad-cb'),
          verifyReceiptSignature: () => false,
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );
    } finally {
      chmodSync(join(hmacRoot, 'cas', 'sha256'), 0o700);
      await seededHmac.store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle: refuses 1-byte tampered .cubin blob, symlink blob, hardlink (nlink > 1) blob, and unverified dispatch blob with ARTIFACT_INVALID', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-tamper-'));
  try {
    // 1. 1-byte tampered .cubin blob in CAS
    const tamperRoot = join(tempDir, 'camp-tamper');
    const seededTamper = await seedSingleTargetCampaign(tamperRoot);
    try {
      const cubinPath = join(tamperRoot, 'cas', 'sha256', seededTamper.cubinDigest.hex);
      chmodSync(cubinPath, 0o600);
      const mutated = Buffer.from(seededTamper.cubinBytes);
      mutated[mutated.byteLength - 1] = mutated[mutated.byteLength - 1]! ^ 0x01;
      writeFileSync(cubinPath, mutated);
      chmodSync(cubinPath, 0o400);

      const outTamper = join(tempDir, 'out-tamper');
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededTamper.store,
          campaignId: seededTamper.campaignId,
          outputDir: outTamper,
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'ARTIFACT_INVALID',
      );
      // Output directory must not be created on pre-export failure
      assert.equal(
        lstatSync(outTamper, { throwIfNoEntry: false }),
        undefined,
      );
    } finally {
      chmodSync(join(tamperRoot, 'cas', 'sha256'), 0o700);
      await seededTamper.store.close();
    }

    // 2. Symlink replacing .cubin blob in CAS -> ARTIFACT_INVALID
    const symlinkRoot = join(tempDir, 'camp-symlink');
    const seededSym = await seedSingleTargetCampaign(symlinkRoot);
    try {
      const externalFile = join(tempDir, 'external.cubin');
      writeFileSync(externalFile, seededSym.cubinBytes);
      const cubinPath = join(symlinkRoot, 'cas', 'sha256', seededSym.cubinDigest.hex);
      chmodSync(cubinPath, 0o600);
      unlinkSync(cubinPath);
      symlinkSync(externalFile, cubinPath);

      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededSym.store,
          campaignId: seededSym.campaignId,
          outputDir: join(tempDir, 'out-symlink'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'ARTIFACT_INVALID',
      );
    } finally {
      chmodSync(join(symlinkRoot, 'cas', 'sha256'), 0o700);
      await seededSym.store.close();
    }

    // 3. Hardlink (nlink > 1) on .cubin blob in CAS -> ARTIFACT_INVALID
    const hardlinkRoot = join(tempDir, 'camp-hardlink');
    const seededHard = await seedSingleTargetCampaign(hardlinkRoot);
    try {
      const cubinPath = join(hardlinkRoot, 'cas', 'sha256', seededHard.cubinDigest.hex);
      const extraLink = join(tempDir, 'hardlinked-cubin-alias');
      linkSync(cubinPath, extraLink);
      assert.equal(lstatSync(cubinPath).nlink, 2);

      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededHard.store,
          campaignId: seededHard.campaignId,
          outputDir: join(tempDir, 'out-hardlink'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'ARTIFACT_INVALID',
      );
    } finally {
      chmodSync(join(hardlinkRoot, 'cas', 'sha256'), 0o700);
      await seededHard.store.close();
    }

    // 4. Dispatch rule pointing to an unverified blob digest not in any selected receipt -> ARTIFACT_INVALID
    const unrefRoot = join(tempDir, 'camp-unref');
    const seededUnref = await seedSingleTargetCampaign(unrefRoot);
    try {
      const fakeDigest = makeDigest('unverified-blob');
      await seededUnref.store.writeCasBlob(Buffer.from('unverified-blob', 'utf8'));
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededUnref.store,
          campaignId: seededUnref.campaignId,
          outputDir: join(tempDir, 'out-unref'),
          receiptSigningSecret: TEST_HMAC_SECRET,
          dispatchManifest: {
            version: 1,
            fallback: 'baseline',
            rules: [
              {
                bucketId: 'bs1-isl4k',
                blobDigest: fakeDigest,
                blobPath: `blobs/sha256/${fakeDigest.hex}`,
                entrypoint: 'rogue_kernel',
              },
            ],
          },
        }),
        'ARTIFACT_INVALID',
      );
      // 5. ByteLength mismatch between receipt outputArtifacts and CAS blob -> ARTIFACT_INVALID
      const badLenRoot = join(tempDir, 'camp-bad-len');
      const storeBadLen = await EvolutionCampaignStore.open({ campaignRoot: badLenRoot });
      try {
        const lease = await storeBadLen.acquireLease('bad-len-owner');
        const manifest = parseEvolutionCampaignDocument(SINGLE_TARGET_CAMPAIGN_YAML);
        const lockHash = makeDigest('lock-bad-len');
        await storeBadLen.createCampaign(lease, {
          campaignId: 'camp-bad-len',
          manifest,
          manifestDigest: makeDigest(SINGLE_TARGET_CAMPAIGN_YAML),
          baseRevision: 'c'.repeat(40),
          lockHash,
          modelIds: ['claude-sonnet-4-6'],
        });
        const islands = await storeBadLen.listIslands('camp-bad-len');
        const blob = await storeBadLen.writeCasBlob(Buffer.from('EXACT_BYTES', 'utf8'));
        const rec = makeSignedReceiptBytes({
          lockHash,
          operationId: 'op-bad-len',
          outputArtifacts: [
            { name: 'kernel.cubin', digest: blob.digest, byteLength: blob.byteLength + 1 },
          ],
        });
        const recCas = await storeBadLen.writeCasBlob(rec.rawBytes);
        await storeBadLen.recordIndividual(lease, {
          individualId: 'ind-bad-len',
          campaignId: 'camp-bad-len',
          islandId: 0,
          generation: 1,
          bucketId: null,
          teamConfigId: islands[0]!.activeTeamConfigId,
          modelId: 'claude-sonnet-4-6',
          trackId: 'cute',
          mutationKind: 'diff_tune',
          status: 'passed',
          failureReason: null,
          nicheKey: 'bound_pipeline=tensor_cube',
          paretoRank: 1,
          crowdingDistance: Number.POSITIVE_INFINITY,
          scalarFitness: 0.9,
          codeSliceCasDigest: makeDigest('code-bl'),
          evidenceDigest: makeDigest('ev-bl'),
          verdictReceiptCasDigest: recCas.digest,
          outputArtifacts: [{ name: 'kernel.cubin', digest: blob.digest, byteLength: blob.byteLength + 1 }],
          metrics: { latency_us_p50: 40, goodput_rps: 2000 },
          hardwareProvenance: rec.provenance,
        });

        await assertEvolutionErrorAsync(
          () => exportEvolutionBundle({
            store: storeBadLen,
            campaignId: 'camp-bad-len',
            outputDir: join(tempDir, 'out-bad-len'),
            receiptSigningSecret: TEST_HMAC_SECRET,
          }),
          'ARTIFACT_INVALID',
        );
      } finally {
        chmodSync(join(badLenRoot, 'cas', 'sha256'), 0o700);
        await storeBadLen.close();
      }
    } finally {
      chmodSync(join(unrefRoot, 'cas', 'sha256'), 0o700);
      await seededUnref.store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle (specialist-then-portfolio): refuses export when portfolioHeldOutWorkloadId has not passed, and succeeds once verified portfolio passes', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-portfolio-'));
  try {
    const campaignRoot = join(tempDir, 'campaign');
    const store = await EvolutionCampaignStore.open({ campaignRoot });
    try {
      const lease = await store.acquireLease('portfolio-owner');
      const manifest = parseEvolutionCampaignDocument(PORTFOLIO_CAMPAIGN_YAML);
      const lockHash = makeDigest('lock-portfolio');
      const campaignId = 'camp-portfolio-1';

      await store.createCampaign(lease, {
        campaignId,
        manifest,
        manifestDigest: makeDigest(PORTFOLIO_CAMPAIGN_YAML),
        baseRevision: 'b'.repeat(40),
        lockHash,
        modelIds: ['claude-sonnet-4-6'],
      });

      const islands = await store.listIslands(campaignId);
      const team0 = islands[0]!.activeTeamConfigId;

      const spec1Bytes = Buffer.from('SPEC_BS1_CUBIN', 'utf8');
      const spec2Bytes = Buffer.from('SPEC_BS16_CUBIN', 'utf8');
      const routerBytes = Buffer.from('PORTFOLIO_ROUTER_SO', 'utf8');
      const spec1Cas = await store.writeCasBlob(spec1Bytes);
      const spec2Cas = await store.writeCasBlob(spec2Bytes);
      const routerCas = await store.writeCasBlob(routerBytes);

      const rec1 = makeSignedReceiptBytes({
        lockHash,
        operationId: 'op-spec-1',
        workloadDigest: makeDigest('decode-bs1-4k'),
        outputArtifacts: [{ name: 'spec_bs1.cubin', digest: spec1Cas.digest, byteLength: spec1Cas.byteLength }],
        metrics: { latency_us_p50: 30, goodput_rps: 2000 },
      });
      const rec2 = makeSignedReceiptBytes({
        lockHash,
        operationId: 'op-spec-2',
        workloadDigest: makeDigest('decode-bs16-8k'),
        outputArtifacts: [{ name: 'spec_bs16.cubin', digest: spec2Cas.digest, byteLength: spec2Cas.byteLength }],
        metrics: { latency_us_p50: 80, goodput_rps: 5000 },
      });
      const rec1Cas = await store.writeCasBlob(rec1.rawBytes);
      const rec2Cas = await store.writeCasBlob(rec2.rawBytes);

      await store.recordIndividual(lease, {
        individualId: 'ind-spec-1',
        campaignId,
        islandId: 0,
        generation: 1,
        bucketId: 'bs1-isl4k',
        teamConfigId: team0,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cute',
        mutationKind: 'full_rewrite',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=tensor_cube',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.9,
        codeSliceCasDigest: makeDigest('code-s1'),
        evidenceDigest: makeDigest('ev-s1'),
        verdictReceiptCasDigest: rec1Cas.digest,
        outputArtifacts: [{ name: 'spec_bs1.cubin', digest: spec1Cas.digest, byteLength: spec1Cas.byteLength }],
        metrics: { latency_us_p50: 30, goodput_rps: 2000 },
        hardwareProvenance: rec1.provenance,
      });

      await store.recordIndividual(lease, {
        individualId: 'ind-spec-2',
        campaignId,
        islandId: 0,
        generation: 1,
        bucketId: 'bs16-isl8k',
        teamConfigId: team0,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cute',
        mutationKind: 'full_rewrite',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=hbm',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.92,
        codeSliceCasDigest: makeDigest('code-s2'),
        evidenceDigest: makeDigest('ev-s2'),
        verdictReceiptCasDigest: rec2Cas.digest,
        outputArtifacts: [{ name: 'spec_bs16.cubin', digest: spec2Cas.digest, byteLength: spec2Cas.byteLength }],
        metrics: { latency_us_p50: 80, goodput_rps: 5000 },
        hardwareProvenance: rec2.provenance,
      });

      // Record a FAILED portfolio evaluation on portfolioHeldOutWorkloadId
      await store.recordIndividual(lease, {
        individualId: 'ind-port-fail',
        campaignId,
        islandId: 0,
        generation: 2,
        bucketId: 'decode-portfolio-holdout',
        teamConfigId: team0,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cute',
        mutationKind: 'portfolio',
        status: 'failed',
        failureReason: 'METRIC_THRESHOLD_FAILED',
        nicheKey: null,
        paretoRank: null,
        crowdingDistance: null,
        scalarFitness: null,
        codeSliceCasDigest: makeDigest('code-pf'),
        evidenceDigest: null,
        verdictReceiptCasDigest: null,
        outputArtifacts: [],
        metrics: { latency_us_p50: 500, goodput_rps: 100 },
      });

      // Must refuse both automatic export AND explicit specialist export before portfolio passes!
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store,
          campaignId,
          outputDir: join(tempDir, 'out-port-denied-1'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store,
          campaignId,
          outputDir: join(tempDir, 'out-port-denied-2'),
          individualIds: ['ind-spec-1', 'ind-spec-2'],
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );

      // Now record a PASSING portfolio individual verified on decode-portfolio-holdout
      const portfolioWorkloadDigest = makeDigest('decode-portfolio-holdout');
      const recPort = makeSignedReceiptBytes({
        lockHash,
        operationId: 'op-port-pass',
        workloadDigest: portfolioWorkloadDigest,
        outputArtifacts: [
          { name: 'portfolio_router.so', digest: routerCas.digest, byteLength: routerCas.byteLength, mediaType: 'application/x-sharedlib' },
        ],
        metrics: { latency_us_p50: 52, goodput_rps: 3800 },
      });
      const recPortCas = await store.writeCasBlob(recPort.rawBytes);

      await store.recordIndividual(lease, {
        individualId: 'ind-port-pass',
        campaignId,
        islandId: 0,
        generation: 3,
        bucketId: 'decode-portfolio-holdout',
        teamConfigId: team0,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cute',
        mutationKind: 'portfolio',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=tensor_cube',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.99,
        codeSliceCasDigest: makeDigest('code-pp'),
        evidenceDigest: makeDigest('ev-pp'),
        verdictReceiptCasDigest: recPortCas.digest,
        outputArtifacts: [
          { name: 'portfolio_router.so', digest: routerCas.digest, byteLength: routerCas.byteLength, mediaType: 'application/x-sharedlib' },
        ],
        metrics: { latency_us_p50: 52, goodput_rps: 3800 },
        hardwareProvenance: recPort.provenance,
        lineageEdges: [
          {
            campaignId,
            childIndividualId: 'ind-port-pass',
            parentIndividualId: 'ind-spec-1',
            role: 'portfolio_member',
            sourceIslandId: 0,
            createdGeneration: 3,
          },
          {
            campaignId,
            childIndividualId: 'ind-port-pass',
            parentIndividualId: 'ind-spec-2',
            role: 'portfolio_member',
            sourceIslandId: 0,
            createdGeneration: 3,
          },
        ],
      });
      await store.updateCampaignProgress(lease, {
        campaignId,
        status: 'completed',
        stagePhase: 'portfolio',
        currentGeneration: 3,
      });

      const outPort = join(tempDir, 'out-port-ok');
      const res = await exportEvolutionBundle({
        store,
        campaignId,
        outputDir: outPort,
        format: 'oci-layout',
        receiptSigningSecret: TEST_HMAC_SECRET,
        dispatchManifest: {
          version: 1,
          fallback: 'baseline',
          rules: [
            {
              bucketId: 'bs1-isl4k',
              dimensionBounds: { batch: { min: 1, max: 4 } },
              blobDigest: spec1Cas.digest,
              entrypoint: 'kernel_bs1',
            },
            {
              bucketId: 'bs16-isl8k',
              dimensionBounds: { batch: { min: 5, max: 32 } },
              blobDigest: spec2Cas.digest,
              entrypoint: 'kernel_bs16',
            },
          ],
        },
      });

      assert.equal(res.format, 'oci-layout');
      assert.deepEqual(res.exportedIndividualIds, ['ind-port-pass', 'ind-spec-1', 'ind-spec-2']);
      assert.equal(res.blobCount, 3);

      const bundleManifest = JSON.parse(
        readFileSync(join(outPort, 'manifest.json'), 'utf8'),
      ) as EvolutionBundleManifestV1;
      assert.equal(bundleManifest.compatibility.workloadDigest.hex, portfolioWorkloadDigest.hex);

      const verified = await verifyEvolutionBundle({
        bundleDir: outPort,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      assert.equal(verified.receiptCount, 3);
      assert.equal(verified.blobCount, 3);
    } finally {
      chmodSync(join(campaignRoot, 'cas', 'sha256'), 0o700);
      await store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle: refuses secrets via SecretScrubber, symlink outputDir, overwrite: false conflict, and incompatible hardware provenance', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-guards-'));
  try {
    // 1. SecretScrubber catches secret in receipt detail
    const secretRoot = join(tempDir, 'camp-secret');
    const seededSecret = await seedSingleTargetCampaign(secretRoot, {
      receiptDetail: 'leaked token ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    });
    try {
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededSecret.store,
          campaignId: seededSecret.campaignId,
          outputDir: join(tempDir, 'out-secret'),
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'SECRET_LEAK_DETECTED',
      );
    } finally {
      chmodSync(join(secretRoot, 'cas', 'sha256'), 0o700);
      await seededSecret.store.close();
    }

    // 2. Custom registered secret in policy.json artifact
    const customSecRoot = join(tempDir, 'camp-custom-secret');
    const seededCustomSec = await seedSingleTargetCampaign(customSecRoot, {
      policyJsonContent: '{"token":"my-super-secret-value-998877"}\n',
    });
    try {
      const scrubber = new SecretScrubber();
      scrubber.register('my-super-secret-value-998877');
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededCustomSec.store,
          campaignId: seededCustomSec.campaignId,
          outputDir: join(tempDir, 'out-custom-secret'),
          receiptSigningSecret: TEST_HMAC_SECRET,
          scrubber,
        }),
        'SECRET_LEAK_DETECTED',
      );
    } finally {
      chmodSync(join(customSecRoot, 'cas', 'sha256'), 0o700);
      await seededCustomSec.store.close();
    }

    // 3. Symlink outputDir & overwrite: false conflict
    const cleanRoot = join(tempDir, 'camp-clean');
    const seededClean = await seedSingleTargetCampaign(cleanRoot);
    try {
      const realTarget = join(tempDir, 'real-dir');
      mkdirSync(realTarget);
      const symOut = join(tempDir, 'sym-out');
      symlinkSync(realTarget, symOut);

      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededClean.store,
          campaignId: seededClean.campaignId,
          outputDir: symOut,
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EVOLUTION_SYMLINK_FORBIDDEN',
      );

      // Existing non-symlink directory with overwrite: false -> EVOLUTION_CONFLICT
      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededClean.store,
          campaignId: seededClean.campaignId,
          outputDir: realTarget,
          overwrite: false,
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'EVOLUTION_CONFLICT',
      );
    } finally {
      chmodSync(join(cleanRoot, 'cas', 'sha256'), 0o700);
      await seededClean.store.close();
    }

    // 4. Incompatible hardware provenance across selected individuals -> ARTIFACT_INVALID
    const mismatchRoot = join(tempDir, 'camp-mismatch');
    const seededMismatch = await seedSingleTargetCampaign(mismatchRoot);
    try {
      const lease = await seededMismatch.store.acquireLease('mismatch-owner');
      const islands = await seededMismatch.store.listIslands(seededMismatch.campaignId);
      const altBlob = await seededMismatch.store.writeCasBlob(Buffer.from('SM89_CUBIN', 'utf8'));
      const altReceipt = makeSignedReceiptBytes({
        lockHash: seededMismatch.lockHash,
        operationId: 'op-alt-sm89',
        accelerator: 'sm_89',
        outputArtifacts: [{ name: 'alt.cubin', digest: altBlob.digest, byteLength: altBlob.byteLength }],
      });
      const altReceiptCas = await seededMismatch.store.writeCasBlob(altReceipt.rawBytes);
      await seededMismatch.store.recordIndividual(lease, {
        individualId: 'ind-win-2-sm89',
        campaignId: seededMismatch.campaignId,
        islandId: 1,
        generation: 4,
        bucketId: null,
        teamConfigId: islands[1]!.activeTeamConfigId,
        modelId: 'claude-sonnet-4-6',
        trackId: 'cute',
        mutationKind: 'diff_tune',
        status: 'passed',
        failureReason: null,
        nicheKey: 'bound_pipeline=hbm',
        paretoRank: 1,
        crowdingDistance: Number.POSITIVE_INFINITY,
        scalarFitness: 0.9,
        codeSliceCasDigest: makeDigest('code-alt'),
        evidenceDigest: makeDigest('ev-alt'),
        verdictReceiptCasDigest: altReceiptCas.digest,
        outputArtifacts: [{ name: 'alt.cubin', digest: altBlob.digest, byteLength: altBlob.byteLength }],
        metrics: { latency_us_p50: 45, goodput_rps: 2500 },
        hardwareProvenance: altReceipt.provenance,
      });

      await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seededMismatch.store,
          campaignId: seededMismatch.campaignId,
          outputDir: join(tempDir, 'out-mismatch'),
          individualIds: ['ind-win-1', 'ind-win-2-sm89'],
          receiptSigningSecret: TEST_HMAC_SECRET,
        }),
        'ARTIFACT_INVALID',
      );
    } finally {
      chmodSync(join(mismatchRoot, 'cas', 'sha256'), 0o700);
      await seededMismatch.store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('bundle (S-C3 + P-W5): requires receiptSigningSecret or verifyReceiptSignature by default, supports explicit allowUnverifiedSignature opt-in, and auto-populates persisted campaign.driverConstraint', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'evo-bundle-sc3-pw5-'));
  try {
    const campRoot = join(tempDir, 'camp');
    const seeded = await seedSingleTargetCampaign(campRoot);
    try {
      const lease = await seeded.store.acquireLease('pw5-driver-owner');
      await seeded.store.updateCampaignProgress(lease, {
        campaignId: seeded.campaignId,
        driverConstraint: '>=560.35,<570.0',
      });

      // 1. Omitting receiptSigningSecret & verifyReceiptSignature on exportEvolutionBundle fails closed
      const unverifiedErr = await assertEvolutionErrorAsync(
        () => exportEvolutionBundle({
          store: seeded.store,
          campaignId: seeded.campaignId,
          outputDir: join(tempDir, 'denied-no-secret'),
        }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );
      assert.match(unverifiedErr.message, /receiptSigningSecret or verifyReceiptSignature is required/);

      // 2. Explicit allowUnverifiedSignature: true succeeds and populates persisted campaign.driverConstraint
      const offlineOut = join(tempDir, 'offline-bundle');
      const exported = await exportEvolutionBundle({
        store: seeded.store,
        campaignId: seeded.campaignId,
        outputDir: offlineOut,
        format: 'dir',
        allowUnverifiedSignature: true,
      });
      assert.equal(exported.format, 'dir');

      const bundleManifest = JSON.parse(
        readFileSync(join(offlineOut, 'manifest.json'), 'utf8'),
      ) as EvolutionBundleManifestV1;
      assert.equal(bundleManifest.compatibility.driverConstraint, '>=560.35,<570.0');

      // 3. verifyEvolutionBundle WITHOUT secret also fails closed unless allowUnverifiedSignature: true
      await assertEvolutionErrorAsync(
        () => verifyEvolutionBundle({ bundleDir: offlineOut }),
        'EXPORT_UNVERIFIED_FORBIDDEN',
      );

      const verifiedOffline = await verifyEvolutionBundle({
        bundleDir: offlineOut,
        allowUnverifiedSignature: true,
      });
      assert.equal(verifiedOffline.manifest.compatibility.driverConstraint, '>=560.35,<570.0');

      // 4. And real HMAC verification succeeds with TEST_HMAC_SECRET
      const verifiedHmac = await verifyEvolutionBundle({
        bundleDir: offlineOut,
        receiptSigningSecret: TEST_HMAC_SECRET,
      });
      assert.equal(verifiedHmac.receiptCount, 1);
    } finally {
      chmodSync(join(campRoot, 'cas', 'sha256'), 0o700);
      await seeded.store.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
