import type {
  ArtifactRef,
  BucketMetricEntry,
  Digest,
  HardwareDiagnostics,
  HardwareProvenance,
  ReworkPolicy,
  StepHandoffSelector,
  StructuredFinding,
} from '@loopwright/core';

export const EVOLUTION_API_VERSION = 'loopwright.dev/v1alpha1' as const;
export const EVOLUTION_CAMPAIGN_KIND = 'EvolutionCampaign' as const;
export const EVOLUTION_CAMPAIGN_MAX_BYTES = 65_536;

export const TEAM_PATCH_KIND = 'TeamPatch' as const;
export const TEAM_PATCH_SCHEMA_VERSION = 'team-patch.v1' as const;
export const TEAM_PATCH_MAX_BYTES = 32_768;
export const TEAM_PATCH_DIAGNOSIS_MAX_BYTES = 4_096;

export const DISPATCH_MANIFEST_MAX_BYTES = 65_536;
export const DISPATCH_MANIFEST_MAX_RULES = 64;

export const SCRATCHPAD_MAX_BYTES = 16_384;
export const CONTEXT_SLICE_MAX_BYTES = 32_768;
export const CAMPAIGN_CLOCK_MAX_DRIFT_MS = 1_000;
export const CAMPAIGN_FORMAT_VERSION = 1 as const;
export const CAMPAIGN_APPLICATION_ID = 0x4c574556;

export const EVOLUTION_ERROR_CODES = Object.freeze([
  'EVOLUTION_SCHEMA_INVALID',
  'EVOLUTION_STORE_ERROR',
  'EVOLUTION_STORE_CLOSED',
  'EVOLUTION_STORE_BUSY',
  'EVOLUTION_STORE_CORRUPT',
  'EVOLUTION_LEASE_FENCED',
  'EVOLUTION_CLOCK_DRIFT',
  'EVOLUTION_SYMLINK_FORBIDDEN',
  'EVOLUTION_NOT_FOUND',
  'EVOLUTION_CONFLICT',
  'EVOLUTION_BUDGET_EXCEEDED',
  'TEAM_ENVELOPE_VIOLATION',
  'EXPORT_UNVERIFIED_FORBIDDEN',
  'ARTIFACT_INVALID',
  'ARTIFACT_MISSING',
  'SECRET_LEAK_DETECTED',
] as const);

export type EvolutionErrorCode = (typeof EVOLUTION_ERROR_CODES)[number];

export class EvolutionError extends Error {
  readonly code: EvolutionErrorCode;
  readonly path?: string;

  constructor(code: EvolutionErrorCode, message: string, path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EvolutionError';
    this.code = code;
    if (path !== undefined) {
      this.path = path;
    }
  }
}

export interface ObjectiveDirectionSpec {
  readonly metric: string;
  readonly direction: 'minimize' | 'maximize';
}

export interface EvolutionSpecialistBucket {
  readonly id: string;
  readonly heldOutWorkloadId: string;
}

export type EvolutionStagesSpec =
  | {
    readonly mode: 'single-target';
    readonly heldOutWorkloadId?: string;
  }
  | {
    readonly mode: 'specialist-then-portfolio';
    readonly specialistBuckets: readonly EvolutionSpecialistBucket[];
    readonly portfolioHeldOutWorkloadId: string;
  };

export interface EvolutionEnumNicheAxis {
  readonly id: string;
  readonly kind: 'enum';
  readonly field?: string;
  readonly values: readonly string[];
}

export interface EvolutionNumericBinsNicheAxis {
  readonly id: string;
  readonly kind: 'numeric_bins';
  readonly field?: string;
  readonly edges: readonly number[];
}

export type EvolutionNicheAxis = EvolutionEnumNicheAxis | EvolutionNumericBinsNicheAxis;

export interface EvolutionPopulationSpec {
  readonly islands: number;
  readonly migrationIntervalGenerations: number;
  readonly maxMigrationElites: number;
  readonly nicheAxes: readonly EvolutionNicheAxis[];
}

export interface EvolutionMutationWeights {
  readonly diff_tune: number;
  readonly full_rewrite: number;
  readonly crossover: number;
}

export type EvolutionModelBanditStrategy = 'deterministic-round-robin' | 'ucb1';

export interface EvolutionSamplingSpec {
  readonly noveltyDecayLambda: number;
  readonly mutationWeights: EvolutionMutationWeights;
  readonly modelBandit: EvolutionModelBanditStrategy;
  readonly maxCrossoversPerPrompt: number;
}

export interface EvolutionTeamSpec {
  readonly enabled: boolean;
  readonly supervisorRoleId: string;
  readonly allowedArchetypeRoles: readonly string[];
  readonly stallGenerations: number;
  readonly minHypervolumeDelta: number;
  readonly triggerOnRunEvalPathology: boolean;
  readonly trialGenerations: number;
  readonly maxTeamSize: number;
  readonly maxTeamSteps: number;
}

export interface EvolutionBudgetsSpec {
  readonly maxGenerations: number;
  readonly maxEvaluations: number;
  readonly maxConcurrentEvaluations: number;
  readonly targetRooflineHeadroom?: number;
  readonly scratchpadIntervalGenerations: number;
}

export type EvolutionExportFormat = 'dir' | 'oci-layout';

export interface EvolutionExportSpec {
  readonly format: EvolutionExportFormat;
  readonly outputDir: string;
}

export interface EvolutionCampaignMetadata {
  readonly name: string;
  readonly description?: string;
}

export interface EvolutionCampaignSpec {
  readonly taskpack: string;
  readonly targetCellId: string;
  readonly heldOutWorkloadId?: string;
  readonly tracks?: readonly string[];
  readonly stages: EvolutionStagesSpec;
  readonly population: EvolutionPopulationSpec;
  readonly sampling: EvolutionSamplingSpec;
  readonly teamEvolution?: EvolutionTeamSpec;
  readonly objectives: readonly ObjectiveDirectionSpec[];
  readonly budgets: EvolutionBudgetsSpec;
  readonly export?: EvolutionExportSpec;
}

export interface EvolutionCampaignManifest {
  readonly apiVersion: typeof EVOLUTION_API_VERSION;
  readonly kind: typeof EVOLUTION_CAMPAIGN_KIND;
  readonly metadata: EvolutionCampaignMetadata;
  readonly spec: EvolutionCampaignSpec;
}

export type TeamPlateauCategory =
  | 'measurement_mismatch'
  | 'coupled_responsibilities'
  | 'local_optimum_anchor'
  | 'resource_spill_trap'
  | 'correctness_ping_pong'
  | 'other';

export interface TeamPatchDiagnosis {
  readonly summary: string;
  readonly plateauCategory: TeamPlateauCategory;
  readonly rationale: string;
}

export interface TeamPatchRole {
  readonly id: string;
  readonly archetypeRoleId: string;
  readonly purpose: 'task' | 'review';
  readonly prompt: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly tools: readonly string[];
  readonly resourceIds?: readonly string[];
  readonly timeoutSeconds?: number;
}

export interface TeamPatchStep {
  readonly id: string;
  readonly roleId: string;
  readonly dependsOn: readonly string[];
  readonly handoffs?: readonly StepHandoffSelector[];
  readonly onRework?: ReworkPolicy;
}

export interface TeamPatchV1 {
  readonly kind: typeof TEAM_PATCH_KIND;
  readonly schemaVersion: typeof TEAM_PATCH_SCHEMA_VERSION;
  readonly diagnosis: TeamPatchDiagnosis;
  readonly roles: readonly TeamPatchRole[];
  readonly steps: readonly TeamPatchStep[];
}

export interface DispatchDimensionRange {
  readonly min?: number;
  readonly max?: number;
}

export interface DispatchRuleV1 {
  readonly bucketId: string;
  readonly dimensionBounds?: Readonly<Record<string, DispatchDimensionRange>>;
  readonly dtypes?: readonly string[];
  readonly alignmentBytes?: number;
  readonly blobDigest: Digest;
  readonly blobPath?: string;
  readonly entrypoint: string;
}

export interface DispatchManifestV1 {
  readonly version: 1;
  readonly fallback: 'baseline';
  readonly rules: readonly DispatchRuleV1[];
}

export interface BundleCompatibilityTuple {
  readonly accelerator: string;
  readonly isolationMode: 'whole_device' | 'sliced';
  readonly deviceCount: number;
  readonly driverVersion: string;
  readonly driverConstraint?: string;
  readonly runtimeVersion: string;
  readonly topology?: string;
  readonly workloadDigest: Digest;
  readonly modelDigest?: Digest;
  readonly parallelismTags?: readonly string[];
}

export interface BundleParetoEntry {
  readonly individualId: string;
  readonly paretoRank: number;
  readonly nicheKey: string | null;
  readonly metrics: Readonly<Record<string, number>>;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
}

export interface BundleLineageProvenance {
  readonly campaignId: string;
  readonly individualIds: readonly string[];
  readonly baseRevision: string;
  readonly lockHash: Digest;
}

export interface BundleMemberDigest {
  readonly path: string;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly mediaType?: string;
}

export interface EvolutionBundleManifestV1 {
  readonly kind: 'EvolutionBundle';
  readonly version: 1;
  readonly compatibility: BundleCompatibilityTuple;
  readonly paretoSummary: readonly BundleParetoEntry[];
  readonly lineage: BundleLineageProvenance;
  readonly members: readonly BundleMemberDigest[];
}

export interface CampaignClockSource {
  nowMonotonicMs(): number;
  nowWallMs(): number;
}

export interface CampaignLease {
  readonly leaseId: string;
  readonly fenceEpoch: number;
}

export interface CampaignMetaRecord {
  readonly formatVersion: number;
  readonly leaseId: string | null;
  readonly fenceEpoch: number;
  readonly createdMonotonicMs: number;
  readonly createdWallMs: number;
  readonly lastMonotonicMs: number;
  readonly lastWallMs: number;
}

export type CampaignStatus = 'active' | 'paused' | 'completed' | 'failed';
export type CampaignStagePhase = 'single-target' | 'specialist' | 'portfolio';

export interface CampaignRecord {
  readonly campaignId: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly stagePhase: CampaignStagePhase;
  readonly activeBucketId: string | null;
  readonly manifest: EvolutionCampaignManifest;
  readonly manifestDigest: Digest;
  readonly baseRevision: string;
  readonly lockHash: Digest;
  readonly driverConstraint: string | null;
  readonly currentGeneration: number;
  readonly evaluationsUsed: number;
  readonly preemptionsCount: number;
  readonly createdAtWallMs: number;
  readonly updatedAtWallMs: number;
}

export interface IslandRecord {
  readonly campaignId: string;
  readonly islandId: number;
  readonly activeTeamConfigId: string;
  readonly currentGeneration: number;
  readonly consecutiveNoGainGenerations: number;
  readonly consecutivePathologyRuns: number;
  readonly lastHypervolume: number;
  readonly bestRooflineHeadroom: number | null;
}

export type TeamConfigStatus = 'baseline' | 'trial' | 'promoted' | 'rolled_back';

export interface TeamConfigRecord {
  readonly teamConfigId: string;
  readonly campaignId: string;
  readonly islandId: number;
  readonly parentTeamConfigId: string | null;
  readonly createdGeneration: number;
  readonly status: TeamConfigStatus;
  readonly trialBudgetGenerations: number;
  readonly trialUsedGenerations: number;
  readonly diagnosis: TeamPatchDiagnosis | null;
  readonly patchCasDigest: Digest | null;
  readonly paretoAdvances: number;
  readonly nicheDiscoveries: number;
}

export type IndividualStatus = 'passed' | 'soft_passed' | 'failed' | 'preempted';
export type IndividualMutationKind = 'baseline' | 'diff_tune' | 'full_rewrite' | 'crossover' | 'portfolio';

export interface IndividualRecord {
  readonly individualId: string;
  readonly campaignId: string;
  readonly islandId: number;
  readonly generation: number;
  readonly bucketId: string | null;
  readonly teamConfigId: string;
  readonly modelId: string;
  readonly trackId: string | null;
  readonly mutationKind: IndividualMutationKind;
  readonly status: IndividualStatus;
  readonly failureReason: string | null;
  readonly nicheKey: string | null;
  readonly paretoRank: number | null;
  readonly crowdingDistance: number | null;
  readonly scalarFitness: number | null;
  readonly offspringCount: number;
  readonly codeSliceCasDigest: Digest | null;
  readonly evidenceDigest: Digest | null;
  readonly verdictReceiptCasDigest: Digest | null;
  readonly outputArtifacts: readonly ArtifactRef[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
  readonly hardwareProvenance?: HardwareProvenance;
  readonly findings?: readonly StructuredFinding[];
  readonly createdAtWallMs: number;
}

export type LineageRole = 'primary' | 'crossover_donor' | 'inspiration' | 'portfolio_member';

export interface LineageEdgeRecord {
  readonly campaignId: string;
  readonly childIndividualId: string;
  readonly parentIndividualId: string;
  readonly role: LineageRole;
  readonly sourceIslandId: number;
  readonly createdGeneration: number;
}

export interface ModelBanditArmRecord {
  readonly campaignId: string;
  readonly modelId: string;
  readonly pullCount: number;
  readonly totalReward: number;
  readonly meanReward: number;
  readonly lastPulledGeneration: number | null;
}

export interface ScratchpadSnapshotRecord {
  readonly snapshotId: string;
  readonly campaignId: string;
  readonly generation: number;
  readonly casDigest: Digest;
  readonly byteLength: number;
  readonly casRelPath: string;
  readonly topGainsCount: number;
  readonly failurePatternsCount: number;
  readonly createdAtWallMs: number;
}
