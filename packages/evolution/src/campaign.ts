import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  admitTask,
  LIMITS,
  SecretScrubber,
  type ArtifactRef,
  type BucketMetricEntry,
  type Digest,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type StructuredFinding,
  type TaskContract,
} from '@loopwright/core';
import {
  inspectRun,
  loadTrustedConfiguration,
  resolveCanonicalCasBlobPath,
  stepCancel,
  stepNext,
  stepSubmit,
  type ControllerPolicyProfile,
  type RunEvalReport,
  type StepVerdict,
} from '@loopwright/controller';
import {
  DECISION_NOVELTY_MAX_HISTORY_SLICES,
  DECISION_NOVELTY_MAX_SLICE_BYTES,
  DECISION_PROVIDER_API_KEY_ENV,
  DECISION_PROVIDER_DEFAULTS,
  DecisionBudgetTracker,
  DEFAULT_DECISION_POLICY,
  evaluateCascadeEscalation,
  evaluateMutationNovelty,
  HttpDecisionTransport,
  routeEvolutionStrategy,
  type DecisionCascadeEscalationResult,
  type DecisionEvolutionMutationKind,
  type DecisionEvolutionStrategyResult,
  type DecisionHardwareDiagnostics,
  type DecisionMutationNoveltyHistoryEntry,
  type DecisionMutationNoveltyResult,
  type DecisionPolicyConfig,
  type DecisionTransport,
} from '@loopwright/decisions';
import { MAX_RECEIPT_FILE_BYTES } from '@loopwright/hardware-runner';
import {
  compileDeclarativeTaskpack,
  loadDeclarativeTaskpack,
  stageCompiledInstructionResources,
  type ExecutionHostPolicy,
  type HostCredentialEnvMap,
  type HostGateEndpointPlan,
  type TaskpackManifest,
  type TaskpackRoleDeclaration,
  type TaskpackStepDeclaration,
  type TaskpackToolName,
} from '@loopwright/taskpack';
import {
  exportEvolutionBundle,
  type ExportEvolutionBundleResult,
  type ReceiptSignatureVerifier,
} from './bundle.js';
import {
  computeHypervolume,
  computeHypervolumeDelta,
  computeNicheKey,
  computeNsga2Ranking,
  computeObjectiveReferenceStats,
  scalarizeFitness,
} from './pareto.js';
import {
  computeTruncatedImprovementReward,
  createSeededPrng,
  sampleParents,
  selectModelCandidate,
  selectRingMigrationElites,
  stageMultiParentContextFiles,
  stagePortfolioSpecialistContextFiles,
  type ParentContextInput,
  type PortfolioSpecialistContextInput,
  type SampledParentEntry,
  type StagedParentContextFile,
} from './sampler.js';
import {
  canonicalizeJson,
  loadEvolutionCampaignFile,
  parseArtifactRefsJson,
  parseBucketMetricsJson,
  parseEvolutionCampaignDocument,
  parseHardwareDiagnosticsJson,
  parseHardwareProvenanceJson,
  parseMetricsRecordJson,
  parseNullProtoJson,
  parseStructuredFindingsJson,
  type NullProtoJson,
} from './schema.js';
import { synthesizeCampaignScratchpad } from './scratchpad.js';
import { EvolutionCampaignStore } from './store.js';
import {
  hasRunEvalLoopPathology,
  recordTeamTrialOutcome,
  runPlateauSupervisorTurn,
  validateAndCompileTeamPatch,
  type IslandTrajectoryEntry,
  type SupervisorRunnerPort,
} from './team-supervisor.js';
import {
  EvolutionError,
  type CampaignClockSource,
  type CampaignLease,
  type CampaignRecord,
  type CampaignStagePhase,
  type DispatchManifestV1,
  type EvolutionCampaignManifest,
  type IndividualMutationKind,
  type IndividualRecord,
  type IndividualStatus,
  type IslandRecord,
  type LineageEdgeRecord,
  type ModelBanditArmRecord,
  type ObjectiveDirectionSpec,
  type ScratchpadSnapshotRecord,
  type TeamConfigRecord,
  type TeamPatchV1,
} from './types.js';

const DEFAULT_CAMPAIGN_SCRUBBER = new SecretScrubber();
const AVAILABLE_EVOLUTION_TRACKS: readonly string[] = Object.freeze([
  'cuda_raw',
  'cute',
  'triton',
  'tilelang',
  'ascend_tile',
  'policy_json',
]);

const DEFAULT_CHILD_TASK_BUDGETS: TaskContract['spec']['budgets'] = Object.freeze({
  wallTimeMs: 600_000,
  totalTokens: 250_000,
  perCallOutputTokens: 16_384,
  maxModelCalls: 16,
  maxConcurrency: 1,
  maxFormatRepairs: 0,
  maxImplementationRepairs: 0,
  maxTransportRetries: 1,
  enforcement: Object.freeze({
    wallTime: 'hard_admission' as const,
    tokens: 'soft_accounting' as const,
    modelCalls: 'hard_admission' as const,
    concurrency: 'hard_admission' as const,
    formatRepairs: 'hard_admission' as const,
    implementationRepairs: 'hard_admission' as const,
    transportRetries: 'hard_admission' as const,
  }),
});

export type EvolutionaryAdvisoryDecision =
  | DecisionMutationNoveltyResult
  | DecisionEvolutionStrategyResult
  | DecisionCascadeEscalationResult;

export interface CheckEvolutionCampaignOptions {
  readonly manifestPath?: string | undefined;
  readonly manifest?: EvolutionCampaignManifest | string | Uint8Array | undefined;
  readonly format?: 'yaml' | 'json' | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly taskpack?: TaskpackManifest | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly allowLoopbackHttp?: boolean | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface CheckEvolutionCampaignResult {
  readonly valid: true;
  readonly manifest: EvolutionCampaignManifest;
  readonly manifestDigest: Digest;
  readonly taskpack: TaskpackManifest;
  readonly targetCellId: string;
  readonly modelIds: readonly string[];
  readonly stageMode: 'single-target' | 'specialist-then-portfolio';
  readonly specialistBucketIds: readonly string[];
  readonly portfolioHeldOutWorkloadId: string | null;
}

export interface CandidateProposalContext {
  readonly campaignId: string;
  readonly individualId: string;
  readonly islandId: number;
  readonly generation: number;
  readonly stagePhase: CampaignStagePhase;
  readonly bucketId: string | null;
  readonly heldOutWorkloadId: string;
  readonly modelId: string;
  readonly trackId: string;
  readonly mutationKind: IndividualMutationKind;
  readonly teamConfigId: string;
  readonly parents: readonly SampledParentEntry[];
  readonly stagedParentFiles: readonly StagedParentContextFile[];
  readonly stagedScratchpadPath?: string | undefined;
  readonly portfolioSpecialists?: readonly IndividualRecord[] | undefined;
}

export interface ScreenCandidateNoveltyOptions {
  readonly candidateId: string;
  readonly candidateSlice: string;
  readonly historySlices: readonly DecisionMutationNoveltyHistoryEntry[];
  readonly policy?: DecisionPolicyConfig | undefined;
  readonly budget?: DecisionBudgetTracker | undefined;
  readonly transport?: DecisionTransport | undefined;
  readonly apiKey?: string | undefined;
  readonly noveltyThreshold?: number | undefined;
  readonly shingleSize?: number | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface ScreenCandidateNoveltyOutcome {
  readonly rejected: boolean;
  readonly failureReason: 'NOVELTY_CLONE_REJECTED' | null;
  readonly decision: DecisionMutationNoveltyResult;
}

export interface BuildStageScopedTaskpackOptions {
  readonly taskpack: TaskpackManifest;
  readonly heldOutWorkloadId: string;
  readonly targetCellId: string;
  readonly teamPatch?: TeamPatchV1 | undefined;
}

export interface CollectedChildBenchmarkArtifacts {
  readonly hasBenchmarkProof: boolean;
  readonly rawVerdictReceiptBytes?: Uint8Array | undefined;
  readonly metrics: Readonly<Record<string, number>>;
  readonly bucketMetrics?: readonly BucketMetricEntry[] | undefined;
  readonly hardwareDiagnostics?: HardwareDiagnostics | undefined;
  readonly hardwareProvenance?: HardwareProvenance | undefined;
  readonly findings?: readonly StructuredFinding[] | undefined;
  readonly outputArtifacts: readonly ArtifactRef[];
  readonly stageABlobs: readonly StageABlobPayload[];
  readonly dispositionReason: string | null;
  readonly retryablePreemption: boolean;
}

export interface CandidateEvaluationProposal extends CandidateProposalContext {
  readonly campaignRoot: string;
  readonly childRunDir: string;
  readonly baseRevision: string;
  readonly manifest: EvolutionCampaignManifest;
  readonly taskpack: TaskpackManifest;
  readonly teamPatch?: TeamPatchV1 | undefined;
  readonly proposedCodeSlice?: string | undefined;
  readonly islandHistorySlices?: readonly DecisionMutationNoveltyHistoryEntry[] | undefined;
  readonly noveltyGate?: ((candidateSlice: string) => Promise<ScreenCandidateNoveltyOutcome>) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface StageABlobPayload {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly mediaType?: string | null | undefined;
}

export interface CandidateEvaluationResult {
  readonly status: IndividualStatus;
  readonly failureReason?: string | null | undefined;
  readonly codeSlice: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly smokeMetrics?: Readonly<Record<string, number>> | undefined;
  readonly bucketMetrics?: readonly BucketMetricEntry[] | undefined;
  readonly hardwareDiagnostics?: HardwareDiagnostics | undefined;
  readonly hardwareProvenance?: HardwareProvenance | undefined;
  readonly findings?: readonly StructuredFinding[] | undefined;
  readonly outputArtifacts?: readonly ArtifactRef[] | undefined;
  readonly stageABlobs?: readonly StageABlobPayload[] | undefined;
  readonly rawVerdictReceiptBytes?: Uint8Array | undefined;
  readonly evidenceDigest?: Digest | null | undefined;
  readonly childRunRelPath?: string | undefined;
  readonly runEvalReport?: RunEvalReport | undefined;
  readonly noveltyDecision?: DecisionMutationNoveltyResult | undefined;
}

export type CandidateEvaluator = (
  proposal: CandidateEvaluationProposal,
) => Promise<CandidateEvaluationResult>;

export interface CandidateAgentStepContext {
  readonly campaignId: string;
  readonly individualId: string;
  readonly islandId: number;
  readonly generation: number;
  readonly stagePhase: CampaignStagePhase;
  readonly bucketId: string | null;
  readonly roleId: string;
  readonly stepId: string;
  readonly workspacePath: string;
  readonly childRunDir: string;
  readonly prompt: string;
  readonly contextFiles: readonly string[];
  readonly modelId: string;
  readonly trackId: string;
  readonly mutationKind: IndividualMutationKind;
  readonly parents: readonly SampledParentEntry[];
  readonly signal?: AbortSignal | undefined;
}

export interface CandidateAgentStepResult {
  readonly submissionFile?: string | undefined;
  readonly verdict?: StepVerdict | undefined;
  readonly status?: 'completed' | 'no_change' | 'failed' | 'blocked' | undefined;
  readonly reason?: string | undefined;
}

export interface ControllerChildRunEvaluatorOptions {
  readonly repositoryRoot: string;
  readonly gateEndpoints?: readonly HostGateEndpointPlan[] | undefined;
  readonly credentialEnvMap?: HostCredentialEnvMap | undefined;
  readonly environment?: ((name: string) => string | undefined) | undefined;
  readonly allowLoopbackHttp?: boolean | undefined;
  readonly policyProfile?: ControllerPolicyProfile | undefined;
  readonly decisionPolicy?: DecisionPolicyConfig | undefined;
  readonly decisionBudget?: DecisionBudgetTracker | undefined;
  readonly decisionTransport?: DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
  readonly agentDriver: (context: CandidateAgentStepContext) => Promise<CandidateAgentStepResult | void>;
  readonly onAfterChildEvaluation?: ((proposal: CandidateEvaluationProposal, result: CandidateEvaluationResult) => Promise<void> | void) | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface RunEvolutionCampaignOptions {
  readonly campaignRoot: string;
  readonly campaignId?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly manifest?: EvolutionCampaignManifest | string | Uint8Array | undefined;
  readonly format?: 'yaml' | 'json' | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly taskpack?: TaskpackManifest | undefined;
  readonly evaluator?: CandidateEvaluator | undefined;
  readonly controllerEvaluatorOptions?: ControllerChildRunEvaluatorOptions | undefined;
  readonly proposeCandidateSlice?: ((context: CandidateProposalContext) => Promise<string>) | undefined;
  readonly supervisorRunner?: SupervisorRunnerPort | undefined;
  readonly decisionPolicy?: DecisionPolicyConfig | undefined;
  readonly decisionTransport?: DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
  readonly environment?: ((name: string) => string | undefined) | undefined;
  readonly clock?: CampaignClockSource | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly autoExport?: boolean | undefined;
  readonly exportFormat?: 'dir' | 'oci-layout' | undefined;
  readonly allowSyntheticProbe?: boolean | undefined;
  readonly receiptSigningSecret?: string | undefined;
  readonly verifyReceiptSignature?: ReceiptSignatureVerifier | undefined;
  readonly dispatchManifest?: DispatchManifestV1 | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface ResumeEvolutionCampaignOptions {
  readonly campaignRoot: string;
  readonly campaignId?: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly taskpack?: TaskpackManifest | undefined;
  readonly evaluator?: CandidateEvaluator | undefined;
  readonly controllerEvaluatorOptions?: ControllerChildRunEvaluatorOptions | undefined;
  readonly proposeCandidateSlice?: ((context: CandidateProposalContext) => Promise<string>) | undefined;
  readonly supervisorRunner?: SupervisorRunnerPort | undefined;
  readonly decisionPolicy?: DecisionPolicyConfig | undefined;
  readonly decisionTransport?: DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
  readonly environment?: ((name: string) => string | undefined) | undefined;
  readonly clock?: CampaignClockSource | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly autoExport?: boolean | undefined;
  readonly exportFormat?: 'dir' | 'oci-layout' | undefined;
  readonly allowSyntheticProbe?: boolean | undefined;
  readonly receiptSigningSecret?: string | undefined;
  readonly verifyReceiptSignature?: ReceiptSignatureVerifier | undefined;
  readonly dispatchManifest?: DispatchManifestV1 | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface RunEvolutionCampaignResult {
  readonly store: EvolutionCampaignStore;
  readonly campaign: CampaignRecord;
  readonly islands: readonly IslandRecord[];
  readonly paretoFrontier: readonly IndividualRecord[];
  readonly noveltyRejectionsCount: number;
  readonly cascadeSoftStopsCount: number;
  readonly advisoryDecisions: readonly EvolutionaryAdvisoryDecision[];
  readonly earlyStoppedByRoofline: boolean;
  readonly exportedBundle?: ExportEvolutionBundleResult | undefined;
}

export interface GetEvolutionCampaignStatusOptions {
  readonly campaignRoot: string;
  readonly campaignId?: string | undefined;
  readonly store?: EvolutionCampaignStore | undefined;
  readonly clock?: CampaignClockSource | undefined;
}

export interface EvolutionCampaignStatus {
  readonly campaign: CampaignRecord;
  readonly islands: readonly IslandRecord[];
  readonly paretoFrontier: readonly IndividualRecord[];
  readonly countsByStatus: {
    readonly passed: number;
    readonly soft_passed: number;
    readonly failed: number;
    readonly preempted: number;
    readonly noveltyRejected: number;
  };
  readonly activeTeams: readonly TeamConfigRecord[];
  readonly latestScratchpad: ScratchpadSnapshotRecord | null;
}

export interface IslandNicheArchiveView {
  readonly islandId: number;
  readonly bucketId: string | null;
  readonly elites: readonly IndividualRecord[];
}

export interface InspectEvolutionCampaignOptions {
  readonly campaignRoot: string;
  readonly campaignId?: string | undefined;
  readonly store?: EvolutionCampaignStore | undefined;
  readonly clock?: CampaignClockSource | undefined;
}

export interface EvolutionCampaignInspection {
  readonly campaign: CampaignRecord;
  readonly islands: readonly IslandRecord[];
  readonly paretoFrontier: readonly IndividualRecord[];
  readonly nicheArchives: readonly IslandNicheArchiveView[];
  readonly teamConfigs: readonly TeamConfigRecord[];
  readonly individuals: readonly IndividualRecord[];
  readonly lineageEdges: readonly LineageEdgeRecord[];
  readonly modelBanditArms: readonly ModelBanditArmRecord[];
  readonly scratchpadSnapshots: readonly ScratchpadSnapshotRecord[];
}

const CONTROLLER_RUN_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FORBIDDEN_RUN_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const DEFAULT_MAX_CHILD_BLOB_BYTES = 67_108_864;

/** Compute a frozen `{ algorithm: 'sha256', hex }` digest over UTF-8 string or raw bytes. */
export function sha256Digest(bytes: Uint8Array | string): Digest {
  return Object.freeze({
    algorithm: 'sha256' as const,
    hex: createHash('sha256').update(bytes).digest('hex'),
  });
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Sanitize an arbitrary string into a strict controller-valid lowercase identifier
 * matching `/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/` (`<= 64` chars), preserving any
 * trailing hexadecimal nonce segment whenever truncation occurs.
 */
export function sanitizeRunId(raw: string): string {
  let cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[._-]{2,}/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

  if (cleaned.length === 0) {
    return `ind-${randomBytes(4).toString('hex')}`;
  }
  if (!/^[a-z]/.test(cleaned)) {
    cleaned = `r-${cleaned}`;
  }
  if (FORBIDDEN_RUN_IDS.has(cleaned)) {
    cleaned = `id-${cleaned}`;
  }

  if (cleaned.length > LIMITS.identifier) {
    const trailingNonceMatch = /[._-]([0-9a-f]{4,16})$/.exec(cleaned);
    const suffix = trailingNonceMatch !== null
      ? trailingNonceMatch[1]!
      : createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
    const maxPrefixLen = Math.max(1, LIMITS.identifier - 1 - suffix.length);
    let prefix = cleaned
      .slice(0, maxPrefixLen)
      .replace(/[^a-z0-9]+$/g, '');
    if (prefix.length === 0 || !/^[a-z]/.test(prefix)) {
      prefix = 'r';
    }
    cleaned = `${prefix}-${suffix}`;
  }

  if (!CONTROLLER_RUN_ID_RE.test(cleaned) || cleaned.length > LIMITS.identifier) {
    return `ind-${randomBytes(4).toString('hex')}`;
  }
  return cleaned;
}

function resolveGitHeadRevision(repositoryRoot: string | undefined): string {
  if (repositoryRoot !== undefined && repositoryRoot.trim().length > 0) {
    try {
      const out = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: resolve(repositoryRoot),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (/^[0-9a-f]{40}$/i.test(out)) {
        return out.toLowerCase();
      }
    } catch {
      // Fall through to deterministic synthetic 40-hex revision
    }
  }
  return '0'.repeat(40);
}

async function resolveCanonicalPathAllowMissingLeaf(rawPath: string, label: string): Promise<string> {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0 || rawPath.includes('\0')) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `${label} must be a non-empty path`, `/${label}`);
  }
  const absPath = resolve(rawPath);
  const missingSegments: string[] = [];
  let cursor = absPath;

  for (;;) {
    const st = await lstat(cursor).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP') {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink loop along ${absPath}`, `/${label}`);
      }
      throw err;
    });
    if (st !== null) {
      const realExisting = await realpath(cursor).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ELOOP') {
          throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink loop along ${absPath}`, `/${label}`);
        }
        throw err;
      });
      return missingSegments.length > 0
        ? join(realExisting, ...missingSegments.reverse())
        : realExisting;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      return absPath;
    }
    missingSegments.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
}

async function assertDisjointCampaignAndRepositoryRoots(
  campaignRoot: string,
  repositoryRoot: string | undefined,
): Promise<void> {
  if (repositoryRoot === undefined || repositoryRoot.trim().length === 0) {
    return;
  }
  const canonicalCampaign = await resolveCanonicalPathAllowMissingLeaf(campaignRoot, 'campaignRoot');
  const canonicalRepo = await resolveCanonicalPathAllowMissingLeaf(repositoryRoot, 'repositoryRoot');
  const campaignPrefix = canonicalCampaign.endsWith(sep) ? canonicalCampaign : `${canonicalCampaign}${sep}`;
  const repoPrefix = canonicalRepo.endsWith(sep) ? canonicalRepo : `${canonicalRepo}${sep}`;

  if (
    canonicalCampaign === canonicalRepo
    || canonicalCampaign.startsWith(repoPrefix)
    || canonicalRepo.startsWith(campaignPrefix)
  ) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      'campaignRoot must live outside repositoryRoot',
      '/campaignRoot',
    );
  }
}

async function copyRegularFileNoFollow(srcFile: string, dstFile: string, preserveExec: boolean): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const st = await lstat(srcFile);
  if (st.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden inside repository tree: "${srcFile}"`, srcFile);
  }
  if (!st.isFile()) return;

  const srcFh = await open(srcFile, constants.O_RDONLY | noFollow).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden inside repository tree: "${srcFile}"`, srcFile);
    }
    throw err;
  });
  let bytes: Buffer;
  try {
    const fdStat = await srcFh.stat();
    if (!fdStat.isFile()) return;
    bytes = await srcFh.readFile();
  } finally {
    await srcFh.close();
  }

  await mkdir(dirname(dstFile), { recursive: true, mode: 0o700 });
  const execBit = preserveExec && (st.mode & 0o111) !== 0;
  const mode = execBit ? 0o755 : 0o644;
  const dstFh = await open(dstFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, mode);
  try {
    await dstFh.writeFile(bytes);
    if (execBit) await dstFh.chmod(0o755);
  } finally {
    await dstFh.close();
  }
}

async function copyGitMetadataDirNoFollow(srcGitDir: string, dstGitDir: string): Promise<void> {
  const st = await lstat(srcGitDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `git directory must not be a symlink: "${srcGitDir}"`, srcGitDir);
  }
  await mkdir(dstGitDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(srcGitDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'hooks') continue;
    const srcChild = join(srcGitDir, entry.name);
    const dstChild = join(dstGitDir, entry.name);
    const childStat = await lstat(srcChild);
    if (childStat.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden inside .git metadata: "${srcChild}"`, srcChild);
    }
    if (childStat.isDirectory()) {
      await copyGitMetadataDirNoFollow(srcChild, dstChild);
    } else if (childStat.isFile()) {
      await copyRegularFileNoFollow(srcChild, dstChild, false);
    }
  }
}

async function copyUntrackedFallbackTreeNoFollow(srcDir: string, dstDir: string): Promise<void> {
  const srcStat = await lstat(srcDir);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `source directory must be a non-symlink directory: "${srcDir}"`, srcDir);
  }
  await mkdir(dstDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const srcChild = join(srcDir, entry.name);
    const dstChild = join(dstDir, entry.name);
    const st = await lstat(srcChild);
    if (st.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden inside repository tree: "${srcChild}"`, srcChild);
    }
    if (st.isDirectory()) {
      await copyUntrackedFallbackTreeNoFollow(srcChild, dstChild);
    } else if (st.isFile()) {
      await copyRegularFileNoFollow(srcChild, dstChild, true);
    }
  }
}

/**
 * Materialize an isolated child Git checkout into `dstRepoDir` by copying tracked Git tree files
 * (`git ls-files -z` with `O_NOFOLLOW` regular-file copy + preserving executable `0o755` mode,
 * refusing any tracked symlink, and copying `.git` metadata without hardlinks or hooks) so
 * untracked directories such as `node_modules/.bin/*` symlinks never cause crashes or recursion.
 */
export async function materializeGitCheckoutNoFollow(srcRepoDir: string, dstRepoDir: string): Promise<void> {
  const srcStat = await lstat(srcRepoDir);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new EvolutionError(
      'EVOLUTION_SYMLINK_FORBIDDEN',
      `source directory must be a non-symlink directory: "${srcRepoDir}"`,
      srcRepoDir,
    );
  }

  const dotGitPath = join(srcRepoDir, '.git');
  const dotGitStat = await lstat(dotGitPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

  if (dotGitStat === null) {
    await copyUntrackedFallbackTreeNoFollow(srcRepoDir, dstRepoDir);
    return;
  }
  if (dotGitStat.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `.git cannot be a symlink: "${dotGitPath}"`, dotGitPath);
  }

  await mkdir(dstRepoDir, { recursive: true, mode: 0o700 });

  if (dotGitStat.isDirectory()) {
    await copyGitMetadataDirNoFollow(dotGitPath, join(dstRepoDir, '.git'));
  } else if (dotGitStat.isFile()) {
    execFileSync('git', ['clone', '--no-hardlinks', '--quiet', '--no-checkout', srcRepoDir, dstRepoDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await rm(join(dstRepoDir, '.git', 'hooks'), { recursive: true, force: true }).catch(() => undefined);
  }

  const rawTracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: srcRepoDir,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const checkedParentDirs = new Set<string>();
  let start = 0;
  for (let i = 0; i <= rawTracked.byteLength; i += 1) {
    if (i < rawTracked.byteLength && rawTracked[i] !== 0) continue;
    if (i > start) {
      const relPath = rawTracked.subarray(start, i).toString('utf8');
      const parts = relPath.split('/');
      if (
        relPath.startsWith('/')
        || parts.some(seg => seg.length === 0 || seg === '.' || seg === '..')
      ) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `invalid tracked Git path "${relPath}"`, relPath);
      }

      let cursorDir = srcRepoDir;
      for (let p = 0; p < parts.length - 1; p += 1) {
        cursorDir = join(cursorDir, parts[p]!);
        if (!checkedParentDirs.has(cursorDir)) {
          const dirSt = await lstat(cursorDir).catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return null;
            throw err;
          });
          if (dirSt !== null && dirSt.isSymbolicLink()) {
            throw new EvolutionError(
              'EVOLUTION_SYMLINK_FORBIDDEN',
              `symlink directory forbidden inside tracked repository path: "${cursorDir}"`,
              cursorDir,
            );
          }
          checkedParentDirs.add(cursorDir);
        }
      }

      const srcFile = join(srcRepoDir, ...parts);
      const fileSt = await lstat(srcFile).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (fileSt !== null) {
        if (fileSt.isSymbolicLink()) {
          throw new EvolutionError(
            'EVOLUTION_SYMLINK_FORBIDDEN',
            `tracked symlink forbidden inside repository tree: "${srcFile}"`,
            srcFile,
          );
        }
        if (fileSt.isFile()) {
          const dstFile = join(dstRepoDir, ...parts);
          await copyRegularFileNoFollow(srcFile, dstFile, true);
        }
      }
    }
    start = i + 1;
  }
}

async function writeReadOnlyScratchpadFile(
  dirPath: string,
  markdown: string,
  scrubber: SecretScrubber,
): Promise<{ readonly filePath: string; readonly digest: Digest; readonly byteLength: number }> {
  const scrubbed = scrubber.scrub(markdown);
  if (scrubbed !== markdown) {
    throw new EvolutionError('SECRET_LEAK_DETECTED', 'secret detected in campaign scratchpad markdown', '/scratchpad');
  }
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const targetPath = join(dirPath, 'scratchpad.md');
  const existing = await lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink scratchpad path forbidden: "${targetPath}"`);
    }
    await chmod(targetPath, 0o600).catch(() => undefined);
    await unlink(targetPath);
  }
  const bytes = Buffer.from(markdown, 'utf8');
  const tmpPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmpPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
  try {
    await fh.writeFile(bytes);
    await fh.chmod(0o400);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, targetPath);
  return Object.freeze({
    filePath: targetPath,
    digest: sha256Digest(bytes),
    byteLength: bytes.byteLength,
  });
}

/** Extract `EVOLVE-BLOCK-START:` .. `EVOLVE-BLOCK-END:` slices from source text, falling back to full text when absent. */
export function extractEvolveBlocksFromSource(text: string): string {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let current: string[] = [];
  for (const line of lines) {
    if (line.includes('EVOLVE-BLOCK-START:')) {
      inBlock = true;
      current = [line];
      continue;
    }
    if (inBlock) {
      current.push(line);
      if (line.includes('EVOLVE-BLOCK-END:')) {
        blocks.push(current.join('\n'));
        inBlock = false;
        current = [];
      }
    }
  }
  return blocks.length > 0 ? `${blocks.join('\n')}\n` : text;
}

/**
 * Screen a candidate's `EVOLVE-BLOCK` source slice against island history (`<= 64` newest slices)
 * BEFORE dispatching `benchmark-gate.v1` Stage A/B, rejecting exact normalized clones (`Jaccard === 1.0`)
 * with `0` network calls and Jev soft-band clones with `NOVELTY_CLONE_REJECTED`.
 */
export async function screenCandidateNoveltyBeforeDispatch(
  options: ScreenCandidateNoveltyOptions,
): Promise<ScreenCandidateNoveltyOutcome> {
  const boundedHistory = options.historySlices
    .slice(-DECISION_NOVELTY_MAX_HISTORY_SLICES)
    .map(entry => ({
      id: entry.id.slice(0, 128),
      sourceSlice: truncateUtf8ByBytes(entry.sourceSlice, DECISION_NOVELTY_MAX_SLICE_BYTES),
    }));
  const boundedCandidateSlice = truncateUtf8ByBytes(options.candidateSlice, DECISION_NOVELTY_MAX_SLICE_BYTES);
  const safeCandidateId = options.candidateId.trim().slice(0, 128) || 'candidate';
  const decision = await evaluateMutationNovelty({
    policy: options.policy ?? DEFAULT_DECISION_POLICY,
    state: {},
    budget: options.budget ?? new DecisionBudgetTracker(),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.scrubber !== undefined ? { scrubber: options.scrubber } : {}),
    novelty: {
      candidateId: safeCandidateId,
      candidateSlice: boundedCandidateSlice,
      historySlices: boundedHistory,
      ...(options.noveltyThreshold !== undefined ? { noveltyThreshold: options.noveltyThreshold } : {}),
      ...(options.shingleSize !== undefined ? { shingleSize: options.shingleSize } : {}),
    },
  });
  const rejected = decision.action === 'reject_resample';
  return Object.freeze({
    rejected,
    failureReason: rejected ? ('NOVELTY_CLONE_REJECTED' as const) : null,
    decision,
  });
}

/**
 * Validate an `EvolutionCampaign` manifest and its linked `Taskpack` fail-closed.
 */
export async function checkEvolutionCampaign(
  options: CheckEvolutionCampaignOptions,
): Promise<CheckEvolutionCampaignResult> {
  const scrubber = options.scrubber ?? DEFAULT_CAMPAIGN_SCRUBBER;

  let manifest: EvolutionCampaignManifest;
  let manifestDigest: Digest;
  let inferredRepoRoot = options.repositoryRoot !== undefined ? resolve(options.repositoryRoot) : undefined;

  if (options.manifestPath !== undefined) {
    const absManifestPath = isAbsolute(options.manifestPath)
      ? resolve(options.manifestPath)
      : resolve(inferredRepoRoot ?? process.cwd(), options.manifestPath);
    manifest = await loadEvolutionCampaignFile(absManifestPath, { scrubber });
    manifestDigest = sha256Digest(canonicalizeJson(manifest));
    if (inferredRepoRoot === undefined) {
      inferredRepoRoot = dirname(absManifestPath);
    }
  } else if (options.manifest !== undefined) {
    if (typeof options.manifest === 'string' || options.manifest instanceof Uint8Array) {
      manifest = parseEvolutionCampaignDocument(options.manifest, { scrubber });
    } else {
      manifest = parseEvolutionCampaignDocument(canonicalizeJson(options.manifest), { scrubber });
    }
    manifestDigest = sha256Digest(canonicalizeJson(manifest));
  } else {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'either manifestPath or manifest is required');
  }

  let taskpack: TaskpackManifest;
  if (options.taskpack !== undefined) {
    taskpack = options.taskpack;
  } else {
    try {
      taskpack = await loadDeclarativeTaskpack({
        manifestPath: manifest.spec.taskpack,
        ...(inferredRepoRoot !== undefined ? { repositoryRoot: inferredRepoRoot } : {}),
        executionMode: 'delegated',
        allowLoopbackHttp: options.allowLoopbackHttp ?? true,
        ...(options.hostPolicy !== undefined ? { hostPolicy: options.hostPolicy } : {}),
      });
    } catch (err: unknown) {
      throw new EvolutionError(
        'EVOLUTION_SCHEMA_INVALID',
        `linked taskpack "${manifest.spec.taskpack}" failed validation: ${err instanceof Error ? err.message : String(err)}`,
        '/spec/taskpack',
      );
    }
  }

  const targetMatrix = taskpack.spec.target?.matrix ?? null;
  const targetCell = targetMatrix?.find(cell => cell.id === manifest.spec.targetCellId);
  if (targetCell === undefined || targetCell.hardware === undefined) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      `targetCellId "${manifest.spec.targetCellId}" must match a hardware target.matrix cell in taskpack "${taskpack.metadata.name}"`,
      '/spec/targetCellId',
    );
  }

  const matchingBenchGates = taskpack.spec.verification.externalGates.filter(
    g => g.implementation === 'benchmark-gate.v1' && g.targetCellId === manifest.spec.targetCellId,
  );
  if (matchingBenchGates.length === 0) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      `taskpack "${taskpack.metadata.name}" must declare a benchmark-gate.v1 externalGate for targetCellId "${manifest.spec.targetCellId}"`,
      '/spec/targetCellId',
    );
  }

  let specialistBucketIds: readonly string[] = Object.freeze([]);
  let portfolioHeldOutWorkloadId: string | null = null;
  if (manifest.spec.stages.mode === 'specialist-then-portfolio') {
    portfolioHeldOutWorkloadId = manifest.spec.stages.portfolioHeldOutWorkloadId;
    const specIds: string[] = [];
    for (const bucket of manifest.spec.stages.specialistBuckets) {
      if (bucket.heldOutWorkloadId === portfolioHeldOutWorkloadId) {
        throw new EvolutionError(
          'EVOLUTION_SCHEMA_INVALID',
          `portfolioHeldOutWorkloadId "${portfolioHeldOutWorkloadId}" must not collide with specialist bucket "${bucket.id}" heldOutWorkloadId`,
          '/spec/stages/portfolioHeldOutWorkloadId',
        );
      }
      specIds.push(bucket.id);
    }
    specialistBucketIds = Object.freeze(specIds);
  }

  if (manifest.spec.teamEvolution?.enabled === true) {
    const teamSpec = manifest.spec.teamEvolution;
    const declaredRoleIds = new Set<string>(
      taskpack.spec.roles !== undefined && taskpack.spec.roles.length > 0
        ? taskpack.spec.roles.map(r => r.id)
        : ['author'],
    );
    for (const archId of teamSpec.allowedArchetypeRoles) {
      if (!declaredRoleIds.has(archId)) {
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `teamEvolution.allowedArchetypeRoles entry "${archId}" is not declared in taskpack "${taskpack.metadata.name}"`,
          '/spec/teamEvolution/allowedArchetypeRoles',
        );
      }
    }
    const supervisorInTaskpack = taskpack.spec.roles?.find(r => r.id === teamSpec.supervisorRoleId);
    if (
      supervisorInTaskpack?.tools !== undefined
      && supervisorInTaskpack.tools.some(t => t === 'write' || t === 'edit' || t === 'delete' || t === 'bash')
    ) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `supervisorRoleId "${teamSpec.supervisorRoleId}" must not declare mutating or exec tools`,
        '/spec/teamEvolution/supervisorRoleId',
      );
    }
  }

  const rawModels = taskpack.spec.models?.map(m => m.id) ?? [];
  const modelIds = Object.freeze(rawModels.length > 0 ? Array.from(new Set(rawModels)) : ['default']);

  return Object.freeze({
    valid: true,
    manifest,
    manifestDigest,
    taskpack,
    targetCellId: manifest.spec.targetCellId,
    modelIds,
    stageMode: manifest.spec.stages.mode,
    specialistBucketIds,
    portfolioHeldOutWorkloadId,
  });
}

/**
 * Build a stage-scoped `TaskpackManifest` rewriting `heldOutWorkloadId` ONLY on `benchmark-gate.v1`
 * gates matching `targetCellId`, and applying validated `teamPatch` roles, `thinking`, `timeoutSeconds`,
 * and `onRework` step policies when present.
 */
export function buildStageScopedTaskpack(options: BuildStageScopedTaskpackOptions): TaskpackManifest;
export function buildStageScopedTaskpack(
  baseTaskpack: TaskpackManifest,
  heldOutWorkloadId: string,
  teamPatch: TeamPatchV1 | undefined,
  targetCellId: string,
): TaskpackManifest;
export function buildStageScopedTaskpack(
  first: BuildStageScopedTaskpackOptions | TaskpackManifest,
  heldOutWorkloadIdArg?: string,
  teamPatchArg?: TeamPatchV1 | undefined,
  targetCellIdArg?: string,
): TaskpackManifest {
  const isOptions = !('apiVersion' in first);
  const baseTaskpack = isOptions ? first.taskpack : first;
  const heldOutWorkloadId = isOptions ? first.heldOutWorkloadId : heldOutWorkloadIdArg!;
  const targetCellId = isOptions ? first.targetCellId : targetCellIdArg!;
  const teamPatch = isOptions ? first.teamPatch : teamPatchArg;

  const updatedGates = baseTaskpack.spec.verification.externalGates.map(gate => {
    if (gate.implementation !== 'benchmark-gate.v1' || gate.targetCellId !== targetCellId) {
      return gate;
    }
    return {
      ...gate,
      heldOutWorkloadId,
    };
  });

  let roles = baseTaskpack.spec.roles;
  let steps = baseTaskpack.spec.steps;
  let limits = baseTaskpack.spec.limits;

  if (teamPatch !== undefined) {
    const baseRoleById = new Map((baseTaskpack.spec.roles ?? []).map(r => [r.id, r] as const));
    const declaredModelsByKey = new Map<string, { readonly provider: string; readonly model: string; readonly thinking?: string }>();
    for (const m of baseTaskpack.spec.models ?? []) {
      const entry = {
        provider: m.provider,
        model: m.id,
        ...(m.thinking !== undefined ? { thinking: m.thinking } : {}),
      };
      declaredModelsByKey.set(m.id, entry);
      declaredModelsByKey.set(`${m.provider}/${m.id}`, entry);
    }
    for (const r of baseTaskpack.spec.roles ?? []) {
      if (r.model !== undefined && r.provider !== undefined) {
        const entry = {
          provider: r.provider,
          model: r.model,
          ...(r.thinking !== undefined ? { thinking: r.thinking } : {}),
        };
        if (!declaredModelsByKey.has(r.model)) {
          declaredModelsByKey.set(r.model, entry);
        }
        if (!declaredModelsByKey.has(`${r.provider}/${r.model}`)) {
          declaredModelsByKey.set(`${r.provider}/${r.model}`, entry);
        }
      }
    }
    const firstModel = baseTaskpack.spec.models?.[0];
    const mappedRoles: TaskpackRoleDeclaration[] = teamPatch.roles.map(pr => {
      const arch = baseRoleById.get(pr.archetypeRoleId);
      const resolvedModel = pr.model !== undefined ? declaredModelsByKey.get(pr.model) : undefined;
      return {
        id: pr.id,
        provider: resolvedModel?.provider ?? arch?.provider ?? firstModel?.provider ?? 'delegated',
        model: resolvedModel?.model ?? pr.model ?? arch?.model ?? firstModel?.id ?? 'default',
        thinking: pr.thinking ?? arch?.thinking ?? resolvedModel?.thinking ?? firstModel?.thinking ?? 'medium',
        purpose: pr.purpose,
        prompt: pr.prompt,
        tools: [...pr.tools] as TaskpackToolName[],
        ...(arch?.instructions !== undefined ? { instructions: arch.instructions } : {}),
        ...(arch?.skills !== undefined ? { skills: arch.skills } : {}),
        ...(arch?.mcpServers !== undefined ? { mcpServers: arch.mcpServers } : {}),
      };
    });

    const roleTimeouts = teamPatch.roles
      .map(r => r.timeoutSeconds)
      .filter((v): v is number => v !== undefined);
    if (roleTimeouts.length > 0) {
      const maxPatchTimeout = Math.max(...roleTimeouts);
      const baseTimeout = baseTaskpack.spec.limits?.toolTimeoutSeconds;
      const narrowedTimeout = baseTimeout !== undefined ? Math.min(baseTimeout, maxPatchTimeout) : maxPatchTimeout;
      limits = {
        ...baseTaskpack.spec.limits,
        toolTimeoutSeconds: narrowedTimeout,
      };
    }

    const mappedAgentSteps: TaskpackStepDeclaration[] = teamPatch.steps.map(ps => ({
      id: ps.id,
      kind: 'agent',
      role: ps.roleId,
      dependsOn: [...ps.dependsOn],
      ...(ps.onRework !== undefined
        ? { onRework: { rejectTo: ps.onRework.rejectTo, maxReworks: ps.onRework.maxReworks } }
        : {}),
      ...(ps.handoffs !== undefined
        ? {
          handoffs: ps.handoffs.map(h => ({
            ...(h.id !== undefined ? { id: h.id } : {}),
            fromStep: h.fromStep,
            source: (h.source as { readonly kind: string }).kind === 'assistant_final'
              ? { kind: 'submission' as const }
              : h.source,
            select: h.select,
            ...(h.maxBytes !== undefined ? { maxBytes: h.maxBytes } : {}),
            ...(h.required !== undefined ? { required: h.required } : {}),
          })),
        }
        : {}),
    }));

    const childrenCount = new Map<string, number>(teamPatch.steps.map(s => [s.id, 0] as const));
    for (const s of teamPatch.steps) {
      for (const dep of s.dependsOn) {
        childrenCount.set(dep, (childrenCount.get(dep) ?? 0) + 1);
      }
    }
    const sinkIds = teamPatch.steps.filter(s => (childrenCount.get(s.id) ?? 0) === 0).map(s => s.id);
    const checkIds = [
      ...baseTaskpack.spec.verification.localChecks.map(c => c.id),
      ...updatedGates.map(g => g.id),
    ];
    const mappedCheckSteps: TaskpackStepDeclaration[] = checkIds.map((chkId, idx) => ({
      id: `check-${chkId}`.slice(0, LIMITS.identifier),
      kind: 'check',
      check: chkId,
      dependsOn: idx === 0 ? sinkIds : [`check-${checkIds[idx - 1]!}`.slice(0, LIMITS.identifier)],
    }));

    roles = mappedRoles;
    steps = [...mappedAgentSteps, ...mappedCheckSteps];
  } else if (baseTaskpack.spec.roles !== undefined && baseTaskpack.spec.roles.length > 1 && baseTaskpack.spec.steps === undefined) {
    const mutatingTaskRoles = baseTaskpack.spec.roles.filter(
      r => (r.purpose ?? 'task') === 'task' && (r.tools === undefined || r.tools.some(t => t === 'write' || t === 'edit')),
    );
    if (mutatingTaskRoles.length >= 1) {
      const chosen = mutatingTaskRoles[0]!;
      roles = [
        {
          ...chosen,
          dependsOn: [],
        },
      ];
    }
  }

  return {
    ...baseTaskpack,
    spec: {
      ...baseTaskpack.spec,
      ...(limits !== undefined ? { limits } : {}),
      ...(roles !== undefined ? { roles } : {}),
      ...(steps !== undefined ? { steps } : {}),
      verification: {
        ...baseTaskpack.spec.verification,
        externalGates: updatedGates,
      },
    },
  };
}

async function readBoundedRegularBytesNoFollow(
  filePath: string,
  maxBytes: number,
  pointer: string,
): Promise<Buffer> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const preStat = await lstat(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink loop forbidden at "${filePath}"`, pointer);
    }
    throw err;
  });
  if (preStat.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink artifact forbidden at "${filePath}"`, pointer);
  }
  if (!preStat.isFile()) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `expected regular file at "${filePath}"`, pointer);
  }
  if (preStat.nlink > 1) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `hardlinked artifact (nlink=${preStat.nlink}) forbidden at "${filePath}"`, pointer);
  }
  if (preStat.size > maxBytes) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `artifact at "${filePath}" exceeds ${maxBytes} bytes`, pointer);
  }

  const fh = await open(filePath, constants.O_RDONLY | noFollow).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink artifact forbidden at "${filePath}"`, pointer);
    }
    throw err;
  });
  try {
    const fdStat = await fh.stat();
    if (!fdStat.isFile()) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `expected regular file at "${filePath}"`, pointer);
    }
    if (fdStat.nlink > 1) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `hardlinked artifact (nlink=${fdStat.nlink}) forbidden at "${filePath}"`, pointer);
    }
    if (fdStat.size > maxBytes) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `artifact at "${filePath}" exceeds ${maxBytes} bytes`, pointer);
    }
    const bytes = await fh.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `artifact at "${filePath}" exceeds ${maxBytes} bytes`, pointer);
    }
    return bytes;
  } finally {
    await fh.close();
  }
}

async function readBoundedNullProtoJsonNoFollow(
  filePath: string,
  maxBytes: number,
  pointer: string,
): Promise<Readonly<Record<string, NullProtoJson>>> {
  const bytes = await readBoundedRegularBytesNoFollow(filePath, maxBytes, pointer);
  const parsed = parseNullProtoJson(bytes.toString('utf8'), maxBytes, pointer);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `expected JSON object at ${pointer}`, pointer);
  }
  return parsed as Readonly<Record<string, NullProtoJson>>;
}

/**
 * Safely collect and validate benchmark proof JSON, signed `responseBytes`, hardware telemetry,
 * and Stage A CAS blobs from a child controller run's `artifacts/` directory (`O_NOFOLLOW`, `nlink === 1`,
 * `MAX_RECEIPT_FILE_BYTES`, null-prototype JSON parsing).
 */
export async function collectChildBenchmarkArtifacts(
  artifactsDir: string,
  runSucceeded: boolean,
  scrubber: SecretScrubber = DEFAULT_CAMPAIGN_SCRUBBER,
): Promise<CollectedChildBenchmarkArtifacts> {
  const dirStat = await lstat(artifactsDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink artifacts directory forbidden: "${artifactsDir}"`, '/artifacts');
    }
    throw err;
  });
  if (dirStat === null) {
    return Object.freeze({
      hasBenchmarkProof: false,
      metrics: Object.freeze({}),
      outputArtifacts: Object.freeze([]),
      stageABlobs: Object.freeze([]),
      dispositionReason: null,
      retryablePreemption: false,
    });
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `artifacts path must be a non-symlink directory: "${artifactsDir}"`, '/artifacts');
  }

  const artifactNames = await readdir(artifactsDir);
  const benchProofFiles = artifactNames
    .filter(n => n.startsWith('benchmark-producer-') && n.endsWith('.proof.json'))
    .sort();

  if (benchProofFiles.length === 0) {
    return Object.freeze({
      hasBenchmarkProof: false,
      metrics: Object.freeze({}),
      outputArtifacts: Object.freeze([]),
      stageABlobs: Object.freeze([]),
      dispositionReason: null,
      retryablePreemption: false,
    });
  }

  const latestProofFile = join(artifactsDir, benchProofFiles[benchProofFiles.length - 1]!);
  const proofJson = await readBoundedNullProtoJsonNoFollow(latestProofFile, MAX_RECEIPT_FILE_BYTES, '/proof');
  const outputRaw = proofJson['output'];
  let benchJson: Readonly<Record<string, NullProtoJson>> = Object.freeze(Object.create(null) as Record<string, NullProtoJson>);

  if (outputRaw !== undefined && outputRaw !== null) {
    if (typeof outputRaw !== 'object' || Array.isArray(outputRaw)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'proof.output must be an object', '/proof/output');
    }
    const outputName = (outputRaw as Readonly<Record<string, NullProtoJson>>)['name'];
    if (
      typeof outputName !== 'string'
      || outputName.length === 0
      || outputName.includes('/')
      || outputName.includes('\\')
      || outputName === '.'
      || outputName === '..'
      || outputName.includes('..')
      || outputName.includes('\0')
    ) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'proof.output.name must be a safe single-segment filename', '/proof/output/name');
    }
    benchJson = await readBoundedNullProtoJsonNoFollow(
      join(artifactsDir, outputName),
      MAX_RECEIPT_FILE_BYTES,
      '/benchmarkOutput',
    );
  }

  let rawVerdictReceiptBytes: Uint8Array | undefined;
  let metrics: Readonly<Record<string, number>> = Object.freeze({});
  let bucketMetrics: readonly BucketMetricEntry[] | undefined;
  let hardwareDiagnostics: HardwareDiagnostics | undefined;
  let hardwareProvenance: HardwareProvenance | undefined;
  let findings: readonly StructuredFinding[] | undefined;
  let outputArtifacts: readonly ArtifactRef[] = Object.freeze([]);
  const stageABlobs: StageABlobPayload[] = [];
  let dispositionReason: string | null = null;
  let retryablePreemption = false;

  const responseB64 = benchJson['responseBytes'];
  const responseSigRaw = benchJson['responseSignature'];
  if (responseB64 !== undefined && responseB64 !== null) {
    if (typeof responseB64 !== 'string' || Buffer.byteLength(responseB64, 'utf8') > MAX_RECEIPT_FILE_BYTES * 2) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'responseBytes must be a bounded base64 string', '/benchmarkOutput/responseBytes');
    }
    if (responseB64.length > 0) {
      const decodedBytes = Buffer.from(responseB64, 'base64');
      if (decodedBytes.byteLength > MAX_RECEIPT_FILE_BYTES) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `decoded responseBytes exceeds ${MAX_RECEIPT_FILE_BYTES} bytes`, '/benchmarkOutput/responseBytes');
      }
      if (typeof responseSigRaw === 'string' && responseSigRaw.length > 0) {
        const sigHex = responseSigRaw.startsWith('sha256=') ? responseSigRaw.slice(7) : responseSigRaw;
        const parsedResp = parseNullProtoJson(decodedBytes.toString('utf8'), MAX_RECEIPT_FILE_BYTES, '/benchmarkOutput/responseBytes');
        if (typeof parsedResp !== 'object' || parsedResp === null || Array.isArray(parsedResp)) {
          throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'decoded responseBytes must be a JSON object', '/benchmarkOutput/responseBytes');
        }
        const signedObj = Object.assign(
          Object.create(null) as Record<string, unknown>,
          parsedResp as Record<string, unknown>,
          { signature: sigHex },
        );
        rawVerdictReceiptBytes = Buffer.from(`${canonicalizeJson(signedObj)}\n`, 'utf8');
      } else {
        rawVerdictReceiptBytes = decodedBytes;
      }
    }
  }

  const dispRaw = benchJson['disposition'];
  if (dispRaw !== undefined && dispRaw !== null) {
    if (typeof dispRaw !== 'object' || Array.isArray(dispRaw)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'disposition must be an object', '/benchmarkOutput/disposition');
    }
    const dispObj = dispRaw as Readonly<Record<string, NullProtoJson>>;
    if (typeof dispObj['reason'] === 'string') {
      dispositionReason = dispObj['reason'];
    }
    if (dispObj['retryablePreemption'] === true || dispositionReason === 'BENCHMARK_PREEMPTED') {
      retryablePreemption = true;
    }
  }

  const verdictRaw = benchJson['verdict'];
  if (verdictRaw !== undefined && verdictRaw !== null) {
    if (typeof verdictRaw !== 'object' || Array.isArray(verdictRaw)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'verdict must be an object or null', '/benchmarkOutput/verdict');
    }
    const verdictObj = verdictRaw as Readonly<Record<string, NullProtoJson>>;
    if (verdictObj['metrics'] !== undefined && verdictObj['metrics'] !== null) {
      metrics = parseMetricsRecordJson(verdictObj['metrics'] as unknown as Readonly<Record<string, number>>);
    }
    if (verdictObj['bucketMetrics'] !== undefined && verdictObj['bucketMetrics'] !== null) {
      bucketMetrics = parseBucketMetricsJson(verdictObj['bucketMetrics'] as unknown as readonly BucketMetricEntry[], scrubber);
    }
    if (verdictObj['hardwareDiagnostics'] !== undefined && verdictObj['hardwareDiagnostics'] !== null) {
      hardwareDiagnostics = parseHardwareDiagnosticsJson(verdictObj['hardwareDiagnostics'] as unknown as HardwareDiagnostics, scrubber);
    }
    if (verdictObj['hardwareProvenance'] !== undefined && verdictObj['hardwareProvenance'] !== null) {
      hardwareProvenance = parseHardwareProvenanceJson(verdictObj['hardwareProvenance'] as unknown as HardwareProvenance);
    }
    if (verdictObj['findings'] !== undefined && verdictObj['findings'] !== null) {
      findings = parseStructuredFindingsJson(verdictObj['findings'] as unknown as readonly StructuredFinding[], '/verdict/findings');
    }
    if (dispositionReason === null && typeof verdictObj['reason'] === 'string') {
      dispositionReason = verdictObj['reason'];
    }
    if (verdictObj['outputArtifacts'] !== undefined && verdictObj['outputArtifacts'] !== null && runSucceeded) {
      const validatedRefs = parseArtifactRefsJson(verdictObj['outputArtifacts'] as unknown as readonly ArtifactRef[], '/verdict/outputArtifacts');
      for (const artRef of validatedRefs) {
        const casPath = await resolveCanonicalCasBlobPath(artifactsDir, artRef.digest.hex);
        const blobBytes = await readBoundedRegularBytesNoFollow(
          casPath,
          DEFAULT_MAX_CHILD_BLOB_BYTES,
          `/verdict/outputArtifacts/${artRef.name}`,
        );
        if (blobBytes.byteLength !== artRef.byteLength) {
          throw new EvolutionError(
            'ARTIFACT_INVALID',
            `Stage A CAS blob "${artRef.name}" byteLength mismatch (expected ${artRef.byteLength}, got ${blobBytes.byteLength})`,
            `/verdict/outputArtifacts/${artRef.name}`,
          );
        }
        const actualDigest = sha256Digest(blobBytes);
        if (actualDigest.hex !== artRef.digest.hex) {
          throw new EvolutionError(
            'ARTIFACT_INVALID',
            `Stage A CAS blob "${artRef.name}" SHA-256 mismatch`,
            `/verdict/outputArtifacts/${artRef.name}`,
          );
        }
        stageABlobs.push({
          name: artRef.name,
          bytes: blobBytes,
          digest: artRef.digest,
          byteLength: artRef.byteLength,
          ...(artRef.mediaType !== undefined ? { mediaType: artRef.mediaType } : {}),
        });
      }
      outputArtifacts = validatedRefs;
    }
  }

  return Object.freeze({
    hasBenchmarkProof: true,
    ...(rawVerdictReceiptBytes !== undefined ? { rawVerdictReceiptBytes } : {}),
    metrics,
    ...(bucketMetrics !== undefined ? { bucketMetrics } : {}),
    ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
    ...(hardwareProvenance !== undefined ? { hardwareProvenance } : {}),
    ...(findings !== undefined ? { findings } : {}),
    outputArtifacts,
    stageABlobs: Object.freeze(stageABlobs),
    dispositionReason,
    retryablePreemption,
  });
}

/**
 * Create a real child `LocalRunStore` evaluator backed by `@loopwright/controller` (`stepNext` / `stepSubmit`),
 * `evolve-block-guard.v1`, and `benchmark-gate.v1` (`RelayServer` + `runHardwareWorker`).
 */
export function createControllerChildRunEvaluator(
  options: ControllerChildRunEvaluatorOptions,
): CandidateEvaluator {
  const scrubber = options.scrubber ?? DEFAULT_CAMPAIGN_SCRUBBER;
  const resolvedBaseRepo = resolve(options.repositoryRoot);
  const envLookup = options.environment ?? ((name: string) => process.env[name]);

  return async (proposal: CandidateEvaluationProposal): Promise<CandidateEvaluationResult> => {
    await mkdir(proposal.childRunDir, { recursive: true, mode: 0o700 });
    const childRunDir = await realpath(proposal.childRunDir);
    const realBaseRepo = await realpath(resolvedBaseRepo);
    const childRepoDir = join(childRunDir, 'repo');
    const childConfigDir = join(childRunDir, 'config');
    const childDiagRegistryDir = join(childRunDir, 'registry');
    const controllerRunRoot = join(childRunDir, 'controller');
    const runId = sanitizeRunId(proposal.individualId);

    await mkdir(childConfigDir, { recursive: true, mode: 0o700 });
    await mkdir(childDiagRegistryDir, { recursive: true, mode: 0o700 });
    await materializeGitCheckoutNoFollow(realBaseRepo, childRepoDir);

    const realTmpRoot = await realpath(tmpdir());
    const trustedTempDir = await mkdtemp(join(realTmpRoot, 'lw-evo-trusted-reg-'));
    await chmod(trustedTempDir, 0o700);

    try {
      const scopedTaskpack = buildStageScopedTaskpack({
        taskpack: proposal.taskpack,
        heldOutWorkloadId: proposal.heldOutWorkloadId,
        targetCellId: proposal.manifest.spec.targetCellId,
        ...(proposal.teamPatch !== undefined ? { teamPatch: proposal.teamPatch } : {}),
      });

      const normalizedGateEndpoints = options.gateEndpoints?.map(ep => ({
        ...ep,
        url: new URL(ep.url).href,
      }));

      const compiled = await compileDeclarativeTaskpack(scopedTaskpack, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/evolution',
        hostPolicy: {
          policyProfile: options.policyProfile ?? 'local',
          allowWorkflowWrites: false,
        },
        repositoryRoot: childRepoDir,
        baseRevision: proposal.baseRevision,
        sourceRevision: proposal.baseRevision,
        taskpackPath: proposal.manifest.spec.taskpack,
        ...(normalizedGateEndpoints !== undefined ? { gateEndpoints: normalizedGateEndpoints } : {}),
        ...(options.credentialEnvMap !== undefined ? { credentialEnvMap: options.credentialEnvMap } : {}),
        budgets: DEFAULT_CHILD_TASK_BUDGETS,
        scrubber,
      });

      await stageCompiledInstructionResources(trustedTempDir, compiled.instructionResources);

      const extraRegistryResources: Array<{
        readonly id: string;
        readonly kind: 'document';
        readonly path: string;
        readonly digest: Digest;
      }> = [];

      if (proposal.stagedParentFiles.length > 0) {
        const parentResDir = join(trustedTempDir, '.loopwright-evo', 'parents');
        await mkdir(parentResDir, { recursive: true, mode: 0o700 });
        for (let i = 0; i < proposal.stagedParentFiles.length; i += 1) {
          const pf = proposal.stagedParentFiles[i]!;
          const relPath = `.loopwright-evo/parents/parent-${i}.json`;
          const dstPath = join(trustedTempDir, relPath);
          const bytes = await readFile(pf.filePath);
          await writeFile(dstPath, bytes, { mode: 0o400 });
          await chmod(dstPath, 0o400);
          extraRegistryResources.push({
            id: `evo-parent-${i}`,
            kind: 'document',
            path: relPath,
            digest: pf.digest,
          });
        }
      }

      if (proposal.stagedScratchpadPath !== undefined) {
        const scDir = join(trustedTempDir, '.loopwright-evo', 'scratchpad');
        await mkdir(scDir, { recursive: true, mode: 0o700 });
        const scBytes = await readFile(proposal.stagedScratchpadPath);
        const relPath = '.loopwright-evo/scratchpad/latest.md';
        const dstPath = join(trustedTempDir, relPath);
        await writeFile(dstPath, scBytes, { mode: 0o400 });
        await chmod(dstPath, 0o400);
        extraRegistryResources.push({
          id: 'evo-scratchpad',
          kind: 'document',
          path: relPath,
          digest: sha256Digest(scBytes),
        });
      }

      const patchRoleById = new Map(
        (proposal.teamPatch?.roles ?? []).map(r => [r.id, r] as const),
      );
      const updatedRoleProfiles = compiled.registry.spec.roleProfiles.map(prof => {
        for (const [rId, pr] of patchRoleById.entries()) {
          if ((prof.id === rId || prof.id === `taskpack.profile.${rId}`) && pr.timeoutSeconds !== undefined) {
            const requestedWallMs = pr.timeoutSeconds * 1000;
            const currentWallMs = prof.limits?.toolWallMs;
            const narrowedWallMs = currentWallMs !== undefined ? Math.min(currentWallMs, requestedWallMs) : requestedWallMs;
            return {
              ...prof,
              limits: {
                ...prof.limits,
                toolWallMs: narrowedWallMs,
              },
            };
          }
        }
        return prof;
      });

      const finalRegistryObj = {
        ...compiled.registry,
        spec: {
          ...compiled.registry.spec,
          resources: extraRegistryResources.length > 0
            ? [...compiled.registry.spec.resources, ...extraRegistryResources]
            : compiled.registry.spec.resources,
          roleProfiles: updatedRoleProfiles,
        },
      };

      const registryBytes = Buffer.from(`${JSON.stringify(finalRegistryObj, null, 2)}\n`, 'utf8');
      const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');
      const registryPath = join(trustedTempDir, 'registry.json');
      await writeFile(registryPath, registryBytes, { mode: 0o600 });
      await chmod(registryPath, 0o600);

      const extraResourceIds = extraRegistryResources.map(r => r.id);
      const updatedTaskRoles = compiled.config.spec.task.spec.roles.map(role => {
        const pr = patchRoleById.get(role.id);
        const baseResIds = pr?.resourceIds !== undefined ? [...pr.resourceIds] : role.resourceIds;
        if (baseResIds === undefined) {
          return role;
        }
        const mergedResIds = extraResourceIds.length > 0
          ? Array.from(new Set([...baseResIds, ...extraResourceIds]))
          : Array.from(new Set(baseResIds));
        return {
          ...role,
          resourceIds: mergedResIds,
        };
      });

      const finalTaskObj = {
        ...compiled.config.spec.task,
        spec: {
          ...compiled.config.spec.task.spec,
          roles: updatedTaskRoles,
          trustedContext: extraRegistryResources.length > 0
            ? {
              ...compiled.config.spec.task.spec.trustedContext,
              resources: [...compiled.config.spec.task.spec.trustedContext.resources, ...extraRegistryResources],
            }
            : compiled.config.spec.task.spec.trustedContext,
        },
      };

      const finalConfigObj = {
        ...compiled.config,
        spec: {
          ...compiled.config.spec,
          registry: {
            name: finalRegistryObj.metadata.name,
            digest: { algorithm: 'sha256' as const, hex: registrySha256 },
          },
          task: finalTaskObj,
        },
      };

      const configBytes = Buffer.from(`${JSON.stringify(finalConfigObj, null, 2)}\n`, 'utf8');
      const configPath = join(childConfigDir, 'config.json');
      await writeFile(configPath, configBytes, { mode: 0o600 });
      await chmod(configPath, 0o600);

      await writeFile(join(childDiagRegistryDir, 'registry.json'), registryBytes, { mode: 0o600 });
      await writeFile(join(childDiagRegistryDir, 'config.json'), configBytes, { mode: 0o600 });

      const loadedRes = await loadTrustedConfiguration({
        configPath,
        registryPath,
        registrySha256,
        untrustedRoots: [childRepoDir],
        environment: envLookup,
      });
      if (!loadedRes.ok) {
        throw new EvolutionError(
          'EVOLUTION_STORE_ERROR',
          `child run loadTrustedConfiguration failed: ${loadedRes.error.code} (${loadedRes.error.path})`,
        );
      }

      const evolveGuardDecl = scopedTaskpack.spec.verification.localChecks.find(
        c => c.implementation === 'evolve-block-guard.v1',
      );
      const guardedFiles = Array.isArray(evolveGuardDecl?.parameters?.['files'])
        ? (evolveGuardDecl.parameters['files'] as readonly string[])
        : [];
      const extractWorkspaceSlice = async (workspaceDir: string): Promise<string> => {
        let slice = proposal.proposedCodeSlice ?? '';
        if (guardedFiles.length > 0) {
          const slices: string[] = [];
          for (const rel of guardedFiles) {
            const candidatePath = join(workspaceDir, rel);
            const fallbackPath = join(childRepoDir, rel);
            const content = await readFile(candidatePath, 'utf8').catch(() => readFile(fallbackPath, 'utf8').catch(() => ''));
            if (content.length > 0) {
              slices.push(extractEvolveBlocksFromSource(content));
            }
          }
          if (slices.length > 0) {
            slice = slices.join('\n');
          }
        }
        if (slice.length === 0) {
          slice = `// individual:${proposal.individualId}\n`;
        }
        return slice;
      };

      const allAgentStepIds = finalTaskObj.spec.steps
        .filter(s => s.kind === 'agent')
        .map(s => s.id);
      const stepById = new Map(finalTaskObj.spec.steps.map(s => [s.id, s] as const));
      const completedAgentStepIds = new Set<string>();
      const childRunRelPath = `runs/${proposal.individualId}/controller/${runId}`;
      let noveltyDecisionOut: DecisionMutationNoveltyResult | undefined;
      let latestExtractedSlice: string | undefined;

      let latestWorkspacePath = childRepoDir;
      const tickRes = await stepNext({
        configuration: loadedRes.value,
        repository: childRepoDir,
        runRoot: controllerRunRoot,
        runId,
        mode: 'candidate',
        policyProfile: options.policyProfile ?? 'local',
        allowWorkflowWrites: false,
        environment: envLookup,
        ...(proposal.signal !== undefined ? { signal: proposal.signal } : {}),
      });
      if (!tickRes.ok) {
        throw new EvolutionError('EVOLUTION_STORE_ERROR', `child stepNext failed: ${tickRes.error.code}`);
      }

      let tick = tickRes.value;
      while (tick.kind === 'step') {
        latestWorkspacePath = tick.candidateDir;
        const stepOut = await options.agentDriver({
          campaignId: proposal.campaignId,
          individualId: proposal.individualId,
          islandId: proposal.islandId,
          generation: proposal.generation,
          stagePhase: proposal.stagePhase,
          bucketId: proposal.bucketId,
          roleId: tick.roleId,
          stepId: tick.stepId,
          workspacePath: tick.candidateDir,
          childRunDir,
          prompt: tick.prompt,
          contextFiles: tick.contextFiles,
          modelId: proposal.modelId,
          trackId: proposal.trackId,
          mutationKind: proposal.mutationKind,
          parents: proposal.parents,
          ...(proposal.signal !== undefined ? { signal: proposal.signal } : {}),
        });

        const effectiveStepStatus = stepOut?.status ?? 'completed';
        const stepDecl = stepById.get(tick.stepId);
        if (stepOut?.verdict?.verdict === 'rework' && stepDecl?.onRework !== undefined) {
          const resetQueue = [stepDecl.onRework.rejectTo];
          const visited = new Set<string>();
          while (resetQueue.length > 0) {
            const cur = resetQueue.shift()!;
            if (visited.has(cur)) continue;
            visited.add(cur);
            completedAgentStepIds.delete(cur);
            for (const s of finalTaskObj.spec.steps) {
              if (s.dependsOn.includes(cur)) {
                resetQueue.push(s.id);
              }
            }
          }
        } else if (effectiveStepStatus === 'completed') {
          completedAgentStepIds.add(tick.stepId);
        }

        const allAgentsFinished = allAgentStepIds.length > 0
          && allAgentStepIds.every(id => completedAgentStepIds.has(id))
          && effectiveStepStatus === 'completed'
          && stepOut?.verdict?.verdict !== 'rework';

        // Capture candidate EVOLVE-BLOCK slice BEFORE stepSubmit cleans up tick.candidateDir!
        latestExtractedSlice = await extractWorkspaceSlice(tick.candidateDir);

        if (
          allAgentsFinished
          && proposal.stagePhase !== 'portfolio'
          && proposal.proposedCodeSlice === undefined
          && (
            proposal.noveltyGate !== undefined
            || (proposal.islandHistorySlices !== undefined && proposal.islandHistorySlices.length > 0)
            || options.decisionPolicy !== undefined
            || options.decisionTransport !== undefined
          )
        ) {
          const preGateSlice = latestExtractedSlice;
          const noveltyOutcome = proposal.noveltyGate !== undefined
            ? await proposal.noveltyGate(preGateSlice)
            : await screenCandidateNoveltyBeforeDispatch({
              candidateId: proposal.individualId,
              candidateSlice: preGateSlice,
              historySlices: proposal.islandHistorySlices ?? [],
              ...(options.decisionPolicy !== undefined ? { policy: options.decisionPolicy } : {}),
              ...(options.decisionBudget !== undefined ? { budget: options.decisionBudget } : {}),
              ...(options.decisionTransport !== undefined
                ? { transport: options.decisionTransport }
                : (options.decisionPolicy?.enabled === true ? { transport: new HttpDecisionTransport() } : {})),
              ...(options.decisionApiKey !== undefined ? { apiKey: options.decisionApiKey } : {}),
              scrubber,
            });
          noveltyDecisionOut = noveltyOutcome.decision;
          if (noveltyOutcome.rejected) {
            await stepCancel({ runRoot: controllerRunRoot, runId, environment: envLookup }).catch(() => undefined);
            const rejectedResult: CandidateEvaluationResult = Object.freeze({
              status: 'failed',
              failureReason: 'NOVELTY_CLONE_REJECTED',
              codeSlice: preGateSlice,
              metrics: Object.freeze({}),
              outputArtifacts: Object.freeze([]),
              evidenceDigest: null,
              childRunRelPath,
              noveltyDecision: noveltyOutcome.decision,
            });
            if (options.onAfterChildEvaluation !== undefined) {
              await options.onAfterChildEvaluation(proposal, rejectedResult);
            }
            return rejectedResult;
          }
        }

        const submitRes = await stepSubmit({
          runRoot: controllerRunRoot,
          runId,
          leaseToken: tick.leaseToken,
          ...(stepOut?.submissionFile !== undefined ? { submissionFile: stepOut.submissionFile } : {}),
          ...(stepOut?.verdict !== undefined ? { verdict: stepOut.verdict } : {}),
          status: effectiveStepStatus,
          ...(stepOut?.reason !== undefined ? { reason: stepOut.reason } : {}),
          environment: envLookup,
          ...(proposal.signal !== undefined ? { signal: proposal.signal } : {}),
        });
        if (!submitRes.ok) {
          await stepCancel({ runRoot: controllerRunRoot, runId, environment: envLookup }).catch(() => undefined);
          throw new EvolutionError('EVOLUTION_STORE_ERROR', `child stepSubmit failed: ${submitRes.error.code}`);
        }
        tick = submitRes.value;
      }

      const extractedCodeSlice = latestExtractedSlice ?? await extractWorkspaceSlice(latestWorkspacePath);

      let runEvalReport: RunEvalReport | undefined;
      const inspectedRes = await inspectRun({
        runRoot: controllerRunRoot,
        runId,
      }).catch(() => null);
      if (inspectedRes !== null && inspectedRes.ok && inspectedRes.value.runEval !== null) {
        runEvalReport = inspectedRes.value.runEval;
      }

      const runSucceeded = tick.kind === 'result' && tick.result.spec.status === 'completed';
      const terminalStatusLabel = tick.kind === 'result' ? tick.result.spec.status : 'incident';

      const artifactsDir = join(controllerRunRoot, runId, 'artifacts');
      const collected = await collectChildBenchmarkArtifacts(artifactsDir, runSucceeded, scrubber);

      let finalStatus: IndividualStatus;
      let failureReason: string | null = null;

      if (collected.retryablePreemption) {
        finalStatus = 'preempted';
        failureReason = 'BENCHMARK_PREEMPTED';
      } else if (runSucceeded) {
        finalStatus = 'passed';
        failureReason = null;
      } else {
        finalStatus = 'failed';
        failureReason = collected.dispositionReason
          ?? (!collected.hasBenchmarkProof ? 'LOCAL_VERIFICATION_FAILED' : `RUN_${terminalStatusLabel.toUpperCase()}`);
      }

      const evalResult: CandidateEvaluationResult = Object.freeze({
        status: finalStatus,
        failureReason,
        codeSlice: extractedCodeSlice,
        metrics: collected.metrics,
        ...(collected.bucketMetrics !== undefined ? { bucketMetrics: collected.bucketMetrics } : {}),
        ...(collected.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: collected.hardwareDiagnostics } : {}),
        ...(collected.hardwareProvenance !== undefined ? { hardwareProvenance: collected.hardwareProvenance } : {}),
        ...(collected.findings !== undefined ? { findings: collected.findings } : {}),
        outputArtifacts: collected.outputArtifacts,
        ...(collected.stageABlobs.length > 0 ? { stageABlobs: collected.stageABlobs } : {}),
        ...(collected.rawVerdictReceiptBytes !== undefined ? { rawVerdictReceiptBytes: collected.rawVerdictReceiptBytes } : {}),
        evidenceDigest: runSucceeded ? sha256Digest(`${proposal.individualId}:${runId}:passed`) : null,
        childRunRelPath,
        ...(runEvalReport !== undefined ? { runEvalReport } : {}),
        ...(noveltyDecisionOut !== undefined ? { noveltyDecision: noveltyDecisionOut } : {}),
      });

      if (options.onAfterChildEvaluation !== undefined) {
        await options.onAfterChildEvaluation(proposal, evalResult);
      }

      return evalResult;
    } finally {
      await rm(trustedTempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

function selectMutationKindDeterministically(
  rng: () => number,
  weights: EvolutionCampaignManifest['spec']['sampling']['mutationWeights'],
  availableParentsCount: number,
): IndividualMutationKind {
  const total = weights.diff_tune + weights.full_rewrite + weights.crossover;
  if (total <= 0) {
    return availableParentsCount >= 2 ? 'crossover' : 'diff_tune';
  }
  const draw = rng() * total;
  let kind: IndividualMutationKind;
  if (draw < weights.diff_tune) {
    kind = 'diff_tune';
  } else if (draw < weights.diff_tune + weights.full_rewrite) {
    kind = 'full_rewrite';
  } else {
    kind = 'crossover';
  }
  if (kind === 'crossover' && availableParentsCount < 2) {
    return availableParentsCount === 1 ? 'diff_tune' : 'full_rewrite';
  }
  return kind;
}

function deriveHypervolumeReferencePoint(
  points: readonly Readonly<Record<string, number>>[],
  objectives: readonly ObjectiveDirectionSpec[],
): Readonly<Record<string, number>> {
  const ref: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const obj of objectives) {
    const vals = points
      .map(p => p[obj.metric])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (vals.length === 0) {
      ref[obj.metric] = obj.direction === 'minimize' ? 1_000_000 : -1_000_000;
      continue;
    }
    if (obj.direction === 'minimize') {
      const worst = Math.max(...vals);
      ref[obj.metric] = worst + Math.max(1, Math.abs(worst) * 0.5);
    } else {
      const worst = Math.min(...vals);
      ref[obj.metric] = Math.min(0, worst - Math.max(1, Math.abs(worst) * 0.5));
    }
  }
  return ref;
}

async function computeBaselineCampaignLockHash(
  taskpack: TaskpackManifest,
  campaignId: string,
  baseRevision: string,
  repositoryRoot: string | undefined,
): Promise<{ readonly lockHash: Digest; readonly baseTaskContract: TaskContract }> {
  const compiled = await compileDeclarativeTaskpack(taskpack, {
    mode: 'candidate',
    executionMode: 'delegated',
    repository: 'local/evolution',
    hostPolicy: { policyProfile: 'local', allowWorkflowWrites: false },
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {}),
    baseRevision,
    sourceRevision: baseRevision,
    gateEndpoints: taskpack.spec.verification.externalGates.map(g => ({
      id: g.endpointId,
      url: g.url ?? 'http://127.0.0.1:9/unused',
      signingCredentialRef: g.signingCredentialRef ?? 'bench-sign',
      ...(g.implementation === 'benchmark-gate.v1' ? { implementation: 'benchmark-gate.v1' as const } : {}),
    })),
    credentialEnvMap: {
      gate: 'LOOPWRIGHT_GATE_SIGNING_SECRET',
      byCredentialRef: { 'bench-sign': 'LOOPWRIGHT_GATE_SIGNING_SECRET' },
    },
    budgets: DEFAULT_CHILD_TASK_BUDGETS,
  });
  const admitted = admitTask(compiled.config.spec.task, {
    admissionId: `admission.${sanitizeRunId(campaignId)}`.slice(0, LIMITS.identifier),
    runId: sanitizeRunId(campaignId),
  });
  if (!admitted.ok) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'unable to derive baseline TaskLock for campaign');
  }
  return {
    lockHash: admitted.value.spec.lockHash,
    baseTaskContract: compiled.config.spec.task,
  };
}

async function runWithConcurrencyLimit<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<readonly T[]> {
  const results = new Array<T>(tasks.length);
  let nextIdx = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  });
  await Promise.all(workers);
  return results;
}

function resolveEffectiveDecisionPolicy(
  explicitPolicy: DecisionPolicyConfig | undefined,
  taskpack: TaskpackManifest,
): DecisionPolicyConfig {
  if (explicitPolicy !== undefined) {
    return explicitPolicy;
  }
  const tpDec = taskpack.spec.decisions;
  if (tpDec === undefined) {
    return DEFAULT_DECISION_POLICY;
  }
  const provider = tpDec.provider ?? DEFAULT_DECISION_POLICY.provider;
  const provDefaults = DECISION_PROVIDER_DEFAULTS[provider];
  return Object.freeze({
    enabled: tpDec.enabled,
    disclosurePolicy: tpDec.disclosurePolicy ?? (tpDec.enabled ? 'repo-approved-redacted-evidence' : 'disabled'),
    minConfidence: tpDec.minConfidence ?? DEFAULT_DECISION_POLICY.minConfidence,
    confirmThreshold: tpDec.confirmThreshold ?? DEFAULT_DECISION_POLICY.confirmThreshold,
    hardDeadlineMs: tpDec.hardDeadlineMs ?? DEFAULT_DECISION_POLICY.hardDeadlineMs,
    maxAttempts: tpDec.maxAttempts ?? DEFAULT_DECISION_POLICY.maxAttempts,
    fallbackRole: 'deterministic',
    onFallbackUnavailable: 'deterministic_default',
    provider,
    endpoint: provDefaults.endpoint,
    model: provDefaults.model,
    startluxOptions: null,
    allowImages: tpDec.allowImages ?? false,
  });
}

function resolveDecisionApiKey(
  explicitApiKey: string | undefined,
  policy: DecisionPolicyConfig,
  envLookup: ((name: string) => string | undefined) | undefined,
  scrubber: SecretScrubber,
): string | undefined {
  let key = explicitApiKey;
  if (key === undefined && envLookup !== undefined) {
    for (const envName of DECISION_PROVIDER_API_KEY_ENV[policy.provider] ?? []) {
      const val = envLookup(envName);
      if (val !== undefined && val.length > 0) {
        key = val;
        break;
      }
    }
  }
  if (key !== undefined && key.length > 0) {
    scrubber.register(key);
  }
  return key;
}

function resolveTargetDriverConstraint(
  taskpack: TaskpackManifest,
  targetCellId: string,
): string | null {
  const cell = taskpack.spec.target?.matrix?.find(item => item.id === targetCellId);
  return cell?.hardware?.driverConstraint ?? null;
}

interface InternalDriverOptions {
  readonly store: EvolutionCampaignStore;
  readonly lease: CampaignLease;
  readonly campaignId: string;
  readonly manifest: EvolutionCampaignManifest;
  readonly taskpack: TaskpackManifest;
  readonly baseTaskContract: TaskContract;
  readonly modelIds: readonly string[];
  readonly driverConstraint: string | null;
  readonly repositoryRoot?: string | undefined;
  readonly evaluator: CandidateEvaluator;
  readonly proposeCandidateSlice?: ((context: CandidateProposalContext) => Promise<string>) | undefined;
  readonly supervisorRunner?: SupervisorRunnerPort | undefined;
  readonly decisionPolicy?: DecisionPolicyConfig | undefined;
  readonly decisionTransport?: DecisionTransport | undefined;
  readonly decisionApiKey?: string | undefined;
  readonly environment?: ((name: string) => string | undefined) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly autoExport: boolean;
  readonly exportFormat?: 'dir' | 'oci-layout' | undefined;
  readonly allowSyntheticProbe: boolean;
  readonly receiptSigningSecret?: string | undefined;
  readonly verifyReceiptSignature?: ReceiptSignatureVerifier | undefined;
  readonly dispatchManifest?: DispatchManifestV1 | undefined;
  readonly scrubber: SecretScrubber;
}

async function refreshStageParetoArchive(
  store: EvolutionCampaignStore,
  lease: CampaignLease,
  campaignId: string,
  bucketId: string | null,
  objectives: readonly ObjectiveDirectionSpec[],
): Promise<readonly IndividualRecord[]> {
  const allStageEligible = (
    await store.listIndividuals(campaignId, { status: ['passed', 'soft_passed'], bucketId })
  ).filter(ind =>
    objectives.every(obj => typeof ind.metrics[obj.metric] === 'number' && Number.isFinite(ind.metrics[obj.metric])),
  );
  if (allStageEligible.length === 0) return [];

  const stats = computeObjectiveReferenceStats(
    allStageEligible.map(ind => ind.metrics),
    objectives,
  );
  const passedInds = allStageEligible.filter(ind => ind.status === 'passed');
  const softPassedInds = allStageEligible.filter(ind => ind.status === 'soft_passed');

  const rankedPassed = passedInds.length > 0
    ? computeNsga2Ranking(
      passedInds.map(ind => ({ individualId: ind.individualId, metrics: ind.metrics })),
      objectives,
    )
    : [];
  const maxPassedRank = rankedPassed.reduce((acc, r) => Math.max(acc, r.paretoRank), 1);

  const rankedSoft = softPassedInds.length > 0
    ? computeNsga2Ranking(
      softPassedInds.map(ind => ({ individualId: ind.individualId, metrics: ind.metrics })),
      objectives,
    )
    : [];

  const rankMap = new Map<string, { readonly paretoRank: number; readonly crowdingDistance: number }>();
  for (const r of rankedPassed) {
    rankMap.set(r.individualId, r);
  }
  for (const r of rankedSoft) {
    rankMap.set(r.individualId, {
      paretoRank: maxPassedRank + r.paretoRank,
      crowdingDistance: r.crowdingDistance,
    });
  }

  await store.updateParetoRanks(
    lease,
    campaignId,
    allStageEligible.map(ind => {
      const r = rankMap.get(ind.individualId)!;
      const sf = scalarizeFitness(ind.metrics, objectives, stats);
      return {
        individualId: ind.individualId,
        paretoRank: r.paretoRank,
        crowdingDistance: r.crowdingDistance,
        scalarFitness: sf,
      };
    }),
  );

  return store.listIndividuals(campaignId, { status: ['passed', 'soft_passed'], bucketId });
}

async function driveCampaignExecution(opts: InternalDriverOptions): Promise<RunEvolutionCampaignResult> {
  const { store, lease, campaignId, manifest, taskpack, baseTaskContract, modelIds, evaluator, scrubber } = opts;
  const budgets = manifest.spec.budgets;
  const population = manifest.spec.population;
  const sampling = manifest.spec.sampling;
  const objectives = manifest.spec.objectives;
  const declaredTracks = manifest.spec.tracks ?? AVAILABLE_EVOLUTION_TRACKS;
  const effectiveDecisionPolicy = resolveEffectiveDecisionPolicy(opts.decisionPolicy, taskpack);
  const effectiveDecisionTransport: DecisionTransport | undefined = opts.decisionTransport
    ?? (effectiveDecisionPolicy.enabled ? new HttpDecisionTransport() : undefined);
  const resolvedDecisionApiKey = resolveDecisionApiKey(
    opts.decisionApiKey,
    effectiveDecisionPolicy,
    opts.environment ?? ((name: string) => process.env[name]),
    scrubber,
  );

  let noveltyRejectionsCount = 0;
  let cascadeSoftStopsCount = 0;
  const advisoryDecisions: EvolutionaryAdvisoryDecision[] = [];
  const decisionBudget = new DecisionBudgetTracker();
  let earlyStoppedByRoofline = false;
  let sequenceCounter = (await store.listIndividuals(campaignId)).length;

  const islandRunEvals = new Map<number, RunEvalReport[]>();
  const islandTrajectories = new Map<number, IslandTrajectoryEntry[]>();

  const defaultBenchGate = taskpack.spec.verification.externalGates.find(
    g => g.implementation === 'benchmark-gate.v1' && g.targetCellId === manifest.spec.targetCellId,
  )!;
  const defaultHeldOutWorkloadId = defaultBenchGate.heldOutWorkloadId!;

  const loadValidatedActiveTeamPatch = async (teamConfigId: string): Promise<TeamPatchV1 | undefined> => {
    const activeTeamRec = await store.getTeamConfig(teamConfigId);
    if (activeTeamRec?.patchCasDigest === null || activeTeamRec?.patchCasDigest === undefined) {
      return undefined;
    }
    if (manifest.spec.teamEvolution?.enabled !== true) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `team patch "${teamConfigId}" cannot execute when manifest.spec.teamEvolution.enabled is not true`,
        '/spec/teamEvolution/enabled',
      );
    }
    const rawPatchBytes = await store.readCasBlob(activeTeamRec.patchCasDigest.hex);
    const compiledPatch = validateAndCompileTeamPatch({
      rawPatch: rawPatchBytes,
      teamEvolution: manifest.spec.teamEvolution,
      baseTaskContract,
      taskpack,
      scrubber,
    });
    return compiledPatch.patch;
  };

  const runStageGenerations = async (params: {
    readonly stagePhase: CampaignStagePhase;
    readonly bucketId: string | null;
    readonly heldOutWorkloadId: string;
    readonly startGen: number;
    readonly maxGenInclusive: number;
    readonly maxEvalsCeiling: number;
  }): Promise<'completed_stage' | 'paused' | 'budget_reached'> => {
    for (let gen = params.startGen; gen <= params.maxGenInclusive; gen += 1) {
      if (opts.signal?.aborted) {
        await store.updateCampaignProgress(lease, { campaignId, status: 'paused' });
        return 'paused';
      }

      const currentCamp = (await store.getCampaign(campaignId))!;
      if (currentCamp.evaluationsUsed >= params.maxEvalsCeiling || currentCamp.evaluationsUsed >= budgets.maxEvaluations) {
        return 'budget_reached';
      }

      if (budgets.targetRooflineHeadroom !== undefined) {
        const stagePassed = await store.listIndividuals(campaignId, { status: ['passed'], bucketId: params.bucketId });
        if (
          stagePassed.some(
            ind =>
              ind.hardwareDiagnostics?.rooflineHeadroom !== undefined
              && ind.hardwareDiagnostics.rooflineHeadroom <= budgets.targetRooflineHeadroom!,
          )
        ) {
          earlyStoppedByRoofline = true;
          return 'completed_stage';
        }
      }

      await store.updateCampaignProgress(lease, {
        campaignId,
        status: 'active',
        stagePhase: params.stagePhase,
        activeBucketId: params.bucketId,
      });

      const stagePassingBefore = await store.listIndividuals(campaignId, {
        status: ['passed', 'soft_passed'],
        bucketId: params.bucketId,
      });

      const migrations = selectRingMigrationElites({
        generation: gen,
        islands: population.islands,
        migrationIntervalGenerations: population.migrationIntervalGenerations,
        maxMigrationElites: population.maxMigrationElites,
        individuals: stagePassingBefore,
      });
      const inspirationByIsland = new Map<number, IndividualRecord[]>();
      for (const mig of migrations) {
        const arr = inspirationByIsland.get(mig.targetIslandId) ?? [];
        arr.push(mig.individual);
        inspirationByIsland.set(mig.targetIslandId, arr);
      }

      const allPriorStageInds = await store.listIndividuals(campaignId, { bucketId: params.bucketId });
      const completedIslandsInGen = new Set<number>(
        allPriorStageInds
          .filter(prior => prior.generation === gen && prior.status !== 'preempted')
          .map(prior => prior.islandId),
      );

      const historySlicesByIsland = new Map<number, DecisionMutationNoveltyHistoryEntry[]>();
      for (let isl = 0; isl < population.islands; isl += 1) {
        const candidates = allPriorStageInds
          .filter(
            prior =>
              prior.islandId === isl
              && (prior.status === 'passed' || prior.status === 'soft_passed')
              && prior.codeSliceCasDigest !== null,
          )
          .slice(-DECISION_NOVELTY_MAX_HISTORY_SLICES);
        const slices: DecisionMutationNoveltyHistoryEntry[] = [];
        for (const prior of candidates) {
          const rawSlice = await store.readCasBlob(prior.codeSliceCasDigest!.hex).catch(() => null);
          if (rawSlice !== null) {
            slices.push({
              id: prior.individualId.slice(0, 128),
              sourceSlice: truncateUtf8ByBytes(rawSlice.toString('utf8'), DECISION_NOVELTY_MAX_SLICE_BYTES),
            });
          }
        }
        historySlicesByIsland.set(isl, slices);
      }

      const latestScratchpadRec = await store.getLatestScratchpadSnapshot(campaignId);
      const latestScratchpadMd = latestScratchpadRec !== null
        ? (await store.readCasBlob(latestScratchpadRec.casDigest.hex)).toString('utf8')
        : undefined;

      const remainingEvals = Math.min(
        budgets.maxEvaluations - currentCamp.evaluationsUsed,
        params.maxEvalsCeiling - currentCamp.evaluationsUsed,
      );
      const islandsList = await store.listIslands(campaignId);

      const preGenNichesByIsland = new Map<number, ReadonlyMap<string, IndividualRecord>>();
      for (let isl = 0; isl < population.islands; isl += 1) {
        preGenNichesByIsland.set(isl, await store.getIslandNicheElites(campaignId, isl, params.bucketId));
      }

      interface IslandSlotOutcome {
        readonly islandId: number;
        readonly teamConfigId: string;
        readonly individual: IndividualRecord;
        readonly primaryParent: IndividualRecord | null;
        readonly runEvalReport?: RunEvalReport | undefined;
      }

      const slotTasks: Array<() => Promise<IslandSlotOutcome | null>> = [];
      let scheduledSlotsInGen = 0;

      for (let isl = 0; isl < population.islands; isl += 1) {
        if (completedIslandsInGen.has(isl)) continue;
        if (scheduledSlotsInGen >= remainingEvals) break;
        scheduledSlotsInGen += 1;

        const islandRec = islandsList.find(item => item.islandId === isl)!;
        const seqIdx = sequenceCounter;
        sequenceCounter += 1;

        slotTasks.push(async (): Promise<IslandSlotOutcome | null> => {
          if (opts.signal?.aborted) return null;

          const nonce = randomBytes(3).toString('hex');
          const individualId = sanitizeRunId(
            `ind-g${gen}-i${isl}-${params.bucketId ?? 'main'}-${nonce}`,
          );
          const childRunDir = join(store.campaignRoot, 'runs', individualId);
          await mkdir(childRunDir, { recursive: true, mode: 0o700 });

          const localNicheMap = preGenNichesByIsland.get(isl) ?? new Map<string, IndividualRecord>();
          const localElites = [...localNicheMap.values()];
          const migratedInspirations = inspirationByIsland.get(isl) ?? [];
          const totalParentPool = localElites.length + migratedInspirations.length;
          const crossoverFeasible = totalParentPool >= 2 && sampling.maxCrossoversPerPrompt > 0;

          const rng = createSeededPrng(`${campaignId}:gen-${gen}:isl-${isl}:seq-${seqIdx}`);
          const sampledMutationKind: DecisionEvolutionMutationKind = localElites.length === 0
            ? 'full_rewrite'
            : (selectMutationKindDeterministically(
              rng,
              crossoverFeasible
                ? sampling.mutationWeights
                : { ...sampling.mutationWeights, crossover: 0 },
              totalParentPool,
            ) as DecisionEvolutionMutationKind);

          let preliminarySelection: ReturnType<typeof sampleParents> | null = null;
          if (localElites.length > 0) {
            preliminarySelection = sampleParents({
              islandId: isl,
              localCandidates: localElites,
              inspirationCandidates: migratedInspirations,
              maxCrossoversPerPrompt: sampling.maxCrossoversPerPrompt,
              noveltyDecayLambda: sampling.noveltyDecayLambda,
              seed: `${campaignId}:parents:g${gen}:i${isl}`,
            });
          }

          const preliminaryPrimary = preliminarySelection?.primary.individual ?? null;
          const parentDiag = preliminaryPrimary?.hardwareDiagnostics;
          const decisionDiag: DecisionHardwareDiagnostics | undefined = parentDiag?.boundPipeline !== undefined
            ? {
              boundPipeline: parentDiag.boundPipeline as DecisionHardwareDiagnostics['boundPipeline'],
              ...(parentDiag.rooflineHeadroom !== undefined ? { rooflineHeadroom: parentDiag.rooflineHeadroom } : {}),
              ...(parentDiag.occupancyPct !== undefined ? { occupancyPct: parentDiag.occupancyPct } : {}),
              ...(parentDiag.localSpillBytes !== undefined ? { localSpillBytes: parentDiag.localSpillBytes } : {}),
            }
            : undefined;

          const configuredAllowedKinds: DecisionEvolutionMutationKind[] = [];
          if (localElites.length === 0) {
            configuredAllowedKinds.push('full_rewrite');
          } else if (effectiveDecisionPolicy.enabled) {
            if (sampling.mutationWeights.diff_tune > 0) configuredAllowedKinds.push('diff_tune');
            if (sampling.mutationWeights.full_rewrite > 0) configuredAllowedKinds.push('full_rewrite');
            if (sampling.mutationWeights.crossover > 0 && crossoverFeasible) configuredAllowedKinds.push('crossover');
            if (configuredAllowedKinds.length === 0) configuredAllowedKinds.push(sampledMutationKind);
          } else {
            configuredAllowedKinds.push(sampledMutationKind);
          }

          const strategyDecision = await routeEvolutionStrategy({
            policy: effectiveDecisionPolicy,
            state: {},
            budget: decisionBudget,
            ...(effectiveDecisionTransport !== undefined ? { transport: effectiveDecisionTransport } : {}),
            ...(resolvedDecisionApiKey !== undefined ? { apiKey: resolvedDecisionApiKey } : {}),
            scrubber,
            strategy: {
              operatorKind: taskpack.metadata.name,
              tensorRank: 4,
              dtype: 'fp16',
              declaredTracks,
              allowedMutationKinds: configuredAllowedKinds,
              stalledGenerations: islandRec.consecutiveNoGainGenerations,
              ...(decisionDiag !== undefined ? { hardwareDiagnostics: decisionDiag } : {}),
            },
          });
          advisoryDecisions.push(strategyDecision);
          const trackId = strategyDecision.trackId;
          const mutationKind: IndividualMutationKind = localElites.length === 0
            ? 'full_rewrite'
            : (strategyDecision.mutationKind === 'crossover' && !crossoverFeasible
              ? (totalParentPool === 1 ? 'diff_tune' : 'full_rewrite')
              : strategyDecision.mutationKind);

          let sampledParents: readonly SampledParentEntry[] = [];
          let primaryParent: IndividualRecord | null = null;
          let stagedParentFiles: readonly StagedParentContextFile[] = [];

          if (preliminarySelection !== null) {
            primaryParent = preliminarySelection.primary.individual;
            sampledParents = mutationKind === 'crossover'
              ? [preliminarySelection.primary, ...preliminarySelection.secondary]
              : [preliminarySelection.primary];

            const parentInputs: ParentContextInput[] = [];
            for (const sp of sampledParents) {
              const codeBytes = sp.individual.codeSliceCasDigest !== null
                ? await store.readCasBlob(sp.individual.codeSliceCasDigest.hex)
                : Buffer.from('// baseline\n', 'utf8');
              parentInputs.push({
                individual: sp.individual,
                role: sp.role as ParentContextInput['role'],
                codeSlice: codeBytes.toString('utf8'),
              });
              await store.incrementOffspringCount(lease, sp.individual.individualId, 1);
            }

            const staged = await stageMultiParentContextFiles({
              stagingDir: join(childRunDir, 'parent-context'),
              parents: parentInputs,
              maxCrossoversPerPrompt: mutationKind === 'crossover' ? sampling.maxCrossoversPerPrompt : 0,
              scrubber,
            });
            stagedParentFiles = staged.files;
          }

          const arms = await store.listModelBanditArms(campaignId);
          const modelPick = selectModelCandidate({
            strategy: sampling.modelBandit,
            modelIds,
            arms,
            sequenceIndex: seqIdx,
          });
          const modelId = modelPick.modelId;

          let stagedScratchpadPath: string | undefined;
          if (latestScratchpadMd !== undefined) {
            const stagedSc = await writeReadOnlyScratchpadFile(
              join(childRunDir, 'scratchpad-context'),
              latestScratchpadMd,
              scrubber,
            );
            stagedScratchpadPath = stagedSc.filePath;
          }

          const activeTeamPatch = await loadValidatedActiveTeamPatch(islandRec.activeTeamConfigId);
          const islandHistorySlices = historySlicesByIsland.get(isl) ?? [];

          const proposalCtx: CandidateProposalContext = {
            campaignId,
            individualId,
            islandId: isl,
            generation: gen,
            stagePhase: params.stagePhase,
            bucketId: params.bucketId,
            heldOutWorkloadId: params.heldOutWorkloadId,
            modelId,
            trackId,
            mutationKind,
            teamConfigId: islandRec.activeTeamConfigId,
            parents: sampledParents,
            stagedParentFiles,
            ...(stagedScratchpadPath !== undefined ? { stagedScratchpadPath } : {}),
          };

          let proposedCodeSlice: string | undefined;
          if (opts.proposeCandidateSlice !== undefined) {
            proposedCodeSlice = await opts.proposeCandidateSlice(proposalCtx);
            const noveltyOutcome = await screenCandidateNoveltyBeforeDispatch({
              candidateId: individualId,
              candidateSlice: proposedCodeSlice,
              historySlices: islandHistorySlices,
              policy: effectiveDecisionPolicy,
              budget: decisionBudget,
              ...(effectiveDecisionTransport !== undefined ? { transport: effectiveDecisionTransport } : {}),
              ...(resolvedDecisionApiKey !== undefined ? { apiKey: resolvedDecisionApiKey } : {}),
              scrubber,
            });
            advisoryDecisions.push(noveltyOutcome.decision);

            if (noveltyOutcome.rejected) {
              noveltyRejectionsCount += 1;
              const sliceCas = await store.writeCasBlob(Buffer.from(proposedCodeSlice, 'utf8'));
              const rejectedInd = await store.recordIndividual(lease, {
                individualId,
                campaignId,
                islandId: isl,
                generation: gen,
                bucketId: params.bucketId,
                teamConfigId: islandRec.activeTeamConfigId,
                modelId,
                trackId,
                mutationKind,
                status: 'failed',
                failureReason: 'NOVELTY_CLONE_REJECTED',
                nicheKey: null,
                paretoRank: null,
                crowdingDistance: null,
                scalarFitness: null,
                countEvaluation: false,
                codeSliceCasDigest: sliceCas.digest,
                evidenceDigest: null,
                verdictReceiptCasDigest: null,
                outputArtifacts: [],
                metrics: {},
              });
              return {
                islandId: isl,
                teamConfigId: islandRec.activeTeamConfigId,
                individual: rejectedInd,
                primaryParent,
              };
            }
          }

          const currentCampaignRow = (await store.getCampaign(campaignId))!;
          const evalOutcome = await evaluator({
            ...proposalCtx,
            campaignRoot: store.campaignRoot,
            childRunDir,
            baseRevision: currentCampaignRow.baseRevision,
            manifest,
            taskpack,
            ...(activeTeamPatch !== undefined ? { teamPatch: activeTeamPatch } : {}),
            ...(proposedCodeSlice !== undefined ? { proposedCodeSlice } : {}),
            islandHistorySlices,
            ...(opts.proposeCandidateSlice === undefined && params.stagePhase !== 'portfolio'
              ? {
                noveltyGate: async (candidateSlice: string) => screenCandidateNoveltyBeforeDispatch({
                  candidateId: individualId,
                  candidateSlice,
                  historySlices: islandHistorySlices,
                  policy: effectiveDecisionPolicy,
                  budget: decisionBudget,
                  ...(effectiveDecisionTransport !== undefined ? { transport: effectiveDecisionTransport } : {}),
                  ...(resolvedDecisionApiKey !== undefined ? { apiKey: resolvedDecisionApiKey } : {}),
                  scrubber,
                }),
              }
              : {}),
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          });

          if (evalOutcome.noveltyDecision !== undefined) {
            advisoryDecisions.push(evalOutcome.noveltyDecision);
          }

          let finalStatus = evalOutcome.status;
          let finalFailureReason = evalOutcome.failureReason ?? null;
          const isNoveltyRejected = finalFailureReason === 'NOVELTY_CLONE_REJECTED';
          if (isNoveltyRejected) {
            noveltyRejectionsCount += 1;
          }

          if (finalStatus === 'passed' && evalOutcome.smokeMetrics !== undefined) {
            const primaryMetric = objectives[0]?.metric ?? 'latency_us_p50';
            if (Object.hasOwn(evalOutcome.smokeMetrics, primaryMetric)) {
              const remainingRatio = Math.max(
                0,
                Math.min(1, (budgets.maxEvaluations - currentCampaignRow.evaluationsUsed) / budgets.maxEvaluations),
              );
              const cascadeDecision = await evaluateCascadeEscalation({
                policy: effectiveDecisionPolicy,
                state: {},
                budget: decisionBudget,
                ...(effectiveDecisionTransport !== undefined ? { transport: effectiveDecisionTransport } : {}),
                ...(resolvedDecisionApiKey !== undefined ? { apiKey: resolvedDecisionApiKey } : {}),
                scrubber,
                cascade: {
                  candidateId: individualId,
                  smokeCorrectnessPassed: true,
                  smokeMetrics: evalOutcome.smokeMetrics,
                  referenceMetrics: primaryParent?.metrics ?? {},
                  primaryMetric,
                  direction: objectives[0]?.direction ?? 'minimize',
                  remainingBudgetRatio: remainingRatio,
                },
              });
              advisoryDecisions.push(cascadeDecision);
              if (cascadeDecision.action === 'prune') {
                finalStatus = 'soft_passed';
                finalFailureReason = 'CASCADE_NOT_ESCALATED';
                cascadeSoftStopsCount += 1;
              }
            }
          }

          const codeCas = await store.writeCasBlob(
            Buffer.from(evalOutcome.codeSlice.length > 0 ? evalOutcome.codeSlice : '// empty\n', 'utf8'),
          );

          let verdictReceiptCasDigest: Digest | null = null;
          if (evalOutcome.rawVerdictReceiptBytes !== undefined) {
            const vrCas = await store.writeCasBlob(evalOutcome.rawVerdictReceiptBytes);
            verdictReceiptCasDigest = vrCas.digest;
          }

          const storedArtifacts: ArtifactRef[] = [];
          if (evalOutcome.stageABlobs !== undefined && evalOutcome.stageABlobs.length > 0) {
            for (const blob of evalOutcome.stageABlobs) {
              const writtenBlob = await store.writeCasBlob(blob.bytes);
              storedArtifacts.push({
                name: blob.name,
                digest: writtenBlob.digest,
                byteLength: writtenBlob.byteLength,
                ...(blob.mediaType !== undefined && blob.mediaType !== null ? { mediaType: blob.mediaType } : {}),
              });
            }
          } else if (evalOutcome.outputArtifacts !== undefined) {
            storedArtifacts.push(...evalOutcome.outputArtifacts);
          }

          const retainsInArchive = finalStatus === 'passed' || finalStatus === 'soft_passed';
          const nicheKey = retainsInArchive
            ? computeNicheKey(population.nicheAxes, evalOutcome.metrics, evalOutcome.hardwareDiagnostics)
            : null;

          const lineageEdges = sampledParents.map(sp => ({
            campaignId,
            childIndividualId: individualId,
            parentIndividualId: sp.individual.individualId,
            role: sp.role,
            sourceIslandId: sp.sourceIslandId,
            createdGeneration: gen,
          }));

          const recorded = await store.recordIndividual(lease, {
            individualId,
            campaignId,
            islandId: isl,
            generation: gen,
            bucketId: params.bucketId,
            teamConfigId: islandRec.activeTeamConfigId,
            modelId,
            trackId,
            mutationKind,
            status: finalStatus,
            failureReason: finalFailureReason,
            nicheKey,
            paretoRank: finalStatus === 'passed' ? 1 : (finalStatus === 'soft_passed' ? 2 : null),
            crowdingDistance: retainsInArchive ? 0 : null,
            scalarFitness: retainsInArchive ? 0.5 : null,
            countEvaluation: !isNoveltyRejected,
            codeSliceCasDigest: codeCas.digest,
            evidenceDigest: evalOutcome.evidenceDigest ?? null,
            verdictReceiptCasDigest,
            outputArtifacts: storedArtifacts,
            metrics: evalOutcome.metrics,
            ...(evalOutcome.bucketMetrics !== undefined ? { bucketMetrics: evalOutcome.bucketMetrics } : {}),
            ...(evalOutcome.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: evalOutcome.hardwareDiagnostics } : {}),
            ...(evalOutcome.hardwareProvenance !== undefined ? { hardwareProvenance: evalOutcome.hardwareProvenance } : {}),
            ...(evalOutcome.findings !== undefined ? { findings: evalOutcome.findings } : {}),
            lineageEdges,
          });

          return {
            islandId: isl,
            teamConfigId: islandRec.activeTeamConfigId,
            individual: recorded,
            primaryParent,
            ...(evalOutcome.runEvalReport !== undefined ? { runEvalReport: evalOutcome.runEvalReport } : {}),
          };
        });
      }

      const rawSlotOutcomes = await runWithConcurrencyLimit(slotTasks, budgets.maxConcurrentEvaluations);
      const slotOutcomes = rawSlotOutcomes.filter((x): x is IslandSlotOutcome => x !== null);

      const updatedStagePassed = await refreshStageParetoArchive(
        store,
        lease,
        campaignId,
        params.bucketId,
        objectives,
      );
      const passedById = new Map(updatedStagePassed.map(ind => [ind.individualId, ind] as const));

      for (const slot of slotOutcomes) {
        if (slot.individual.status === 'preempted' || slot.individual.failureReason === 'NOVELTY_CLONE_REJECTED') {
          continue;
        }
        const refreshedChild = passedById.get(slot.individual.individualId);
        const refreshedParent = slot.primaryParent !== null ? passedById.get(slot.primaryParent.individualId) : undefined;
        let reward = 0;
        if (refreshedChild?.scalarFitness !== null && refreshedChild?.scalarFitness !== undefined) {
          const parentFit = refreshedParent?.scalarFitness ?? 0.5;
          reward = slot.primaryParent === null
            ? Math.max(0, refreshedChild.scalarFitness * 0.1)
            : computeTruncatedImprovementReward(refreshedChild.scalarFitness, parentFit);
        }
        await store.recordModelBanditReward(lease, {
          campaignId,
          modelId: slot.individual.modelId,
          reward,
          generation: gen,
        });
      }

      const minHvDelta = manifest.spec.teamEvolution?.minHypervolumeDelta ?? 0.001;
      for (const slot of slotOutcomes) {
        const isl = slot.islandId;
        const currentIsland = (await store.getIsland(campaignId, isl))!;

        if (slot.runEvalReport !== undefined) {
          const hist = islandRunEvals.get(isl) ?? [];
          hist.push(slot.runEvalReport);
          islandRunEvals.set(isl, hist);
        }

        const beforeMap = preGenNichesByIsland.get(isl) ?? new Map<string, IndividualRecord>();
        const afterMap = await store.getIslandNicheElites(campaignId, isl, params.bucketId);

        let newNichesOpened = 0;
        let upgradedNiche = false;
        for (const [nKey, elite] of afterMap.entries()) {
          const prevElite = beforeMap.get(nKey);
          if (prevElite === undefined) {
            newNichesOpened += 1;
          } else if (prevElite.individualId !== elite.individualId) {
            upgradedNiche = true;
          }
        }

        const beforePoints = [...beforeMap.values()].map(e => e.metrics);
        const afterPoints = [...afterMap.values()].map(e => e.metrics);
        const refPoint = deriveHypervolumeReferencePoint([...beforePoints, ...afterPoints], objectives);
        const hvDelta = computeHypervolumeDelta(beforePoints, afterPoints, objectives, refPoint);
        const nextHv = computeHypervolume(afterPoints, objectives, refPoint);

        const isPreempted = slot.individual.status === 'preempted';
        const advancedPareto = hvDelta >= minHvDelta;
        const discoveredNiche = newNichesOpened > 0 || upgradedNiche;

        const usedTeam = await store.getTeamConfig(slot.teamConfigId);
        if (usedTeam?.status === 'trial') {
          await recordTeamTrialOutcome(store, lease, {
            campaignId,
            islandId: isl,
            teamConfigId: slot.teamConfigId,
            advancedPareto,
            discoveredNiche,
            preempted: isPreempted,
          });
        }

        if (!isPreempted) {
          const nextNoGain = (advancedPareto || newNichesOpened > 0)
            ? 0
            : currentIsland.consecutiveNoGainGenerations + 1;
          const nextPathology = slot.runEvalReport !== undefined && hasRunEvalLoopPathology(slot.runEvalReport)
            ? currentIsland.consecutivePathologyRuns + 1
            : 0;
          const candidateHeadroom = slot.individual.status === 'passed'
            ? slot.individual.hardwareDiagnostics?.rooflineHeadroom
            : undefined;
          const nextBestHeadroom = candidateHeadroom !== undefined
            ? (currentIsland.bestRooflineHeadroom === null
              ? candidateHeadroom
              : Math.min(currentIsland.bestRooflineHeadroom, candidateHeadroom))
            : currentIsland.bestRooflineHeadroom;

          const updatedIsl = await store.updateIslandProgress(lease, {
            campaignId,
            islandId: isl,
            currentGeneration: gen,
            consecutiveNoGainGenerations: nextNoGain,
            consecutivePathologyRuns: nextPathology,
            lastHypervolume: nextHv,
            bestRooflineHeadroom: nextBestHeadroom,
          });

          const bestSf = afterMap.size > 0
            ? Math.max(...[...afterMap.values()].map(e => e.scalarFitness ?? 0))
            : null;
          const traj = islandTrajectories.get(isl) ?? [];
          traj.push({
            generation: gen,
            hypervolume: nextHv,
            bestScalarFitness: bestSf,
            nichesOpen: afterMap.size,
          });
          islandTrajectories.set(isl, traj);

          if (manifest.spec.teamEvolution?.enabled === true && opts.supervisorRunner !== undefined && !opts.signal?.aborted) {
            const freshCamp = (await store.getCampaign(campaignId))!;
            const islandInds = await store.listIndividuals(campaignId, { islandId: isl, bucketId: params.bucketId });
            const evalsForIsl = islandRunEvals.get(isl);
            await runPlateauSupervisorTurn({
              store,
              lease,
              campaignId,
              island: updatedIsl,
              teamEvolution: manifest.spec.teamEvolution,
              budgets,
              evaluationsUsed: freshCamp.evaluationsUsed,
              currentGeneration: gen,
              baseTaskContract,
              taskpack,
              trajectory: traj,
              ...(evalsForIsl !== undefined ? { recentRunEvals: evalsForIsl } : {}),
              recentIndividuals: islandInds.slice(-16),
              ...(latestScratchpadMd !== undefined ? { latestScratchpadMarkdown: latestScratchpadMd } : {}),
              stagingDir: join(store.campaignRoot, 'supervisor', `isl-${isl}-gen-${gen}`),
              supervisorRunner: opts.supervisorRunner,
              scrubber,
            });
          }
        }
      }

      if (opts.signal?.aborted) {
        await store.updateCampaignProgress(lease, { campaignId, status: 'paused' });
        return 'paused';
      }

      const anyPreemptedOnly = slotOutcomes.length > 0 && slotOutcomes.every(s => s.individual.status === 'preempted');
      if (!anyPreemptedOnly) {
        await store.updateCampaignProgress(lease, {
          campaignId,
          status: 'active',
          stagePhase: params.stagePhase,
          activeBucketId: params.bucketId,
          currentGeneration: gen,
        });
      }

      // Periodic campaign scratchpad synthesis
      if (gen > 0 && gen % budgets.scratchpadIntervalGenerations === 0) {
        const allEvaluated = await store.listIndividuals(campaignId);
        if (allEvaluated.length > 0) {
          await synthesizeCampaignScratchpad({
            store,
            lease,
            campaignId,
            generation: gen,
            scrubber,
          });
        }
      }
    }

    return 'completed_stage';
  };

  const currentCampaign = (await store.getCampaign(campaignId))!;
  if (manifest.spec.stages.mode === 'single-target') {
    const singleTargetWorkloadId =
      manifest.spec.stages.heldOutWorkloadId
      ?? manifest.spec.heldOutWorkloadId
      ?? defaultHeldOutWorkloadId;
    const startGen = Math.max(1, currentCampaign.currentGeneration + 1);
    const outcome = await runStageGenerations({
      stagePhase: 'single-target',
      bucketId: null,
      heldOutWorkloadId: singleTargetWorkloadId,
      startGen,
      maxGenInclusive: budgets.maxGenerations,
      maxEvalsCeiling: budgets.maxEvaluations,
    });
    if (outcome !== 'paused') {
      await store.updateCampaignProgress(lease, { campaignId, status: 'completed' });
    }
  } else {
    const specBuckets = manifest.spec.stages.specialistBuckets;
    const portfolioWorkloadId = manifest.spec.stages.portfolioHeldOutWorkloadId;
    const gensForSpecialists = Math.max(specBuckets.length, budgets.maxGenerations - 1);
    const gensPerBucket = Math.max(1, Math.floor(gensForSpecialists / specBuckets.length));

    let maxSpecialistGenUsed = currentCampaign.currentGeneration;

    if (currentCampaign.stagePhase !== 'portfolio') {
      const startBucketIdx = currentCampaign.activeBucketId !== null
        ? Math.max(0, specBuckets.findIndex(b => b.id === currentCampaign.activeBucketId))
        : 0;

      for (let bIdx = startBucketIdx; bIdx < specBuckets.length; bIdx += 1) {
        const bucket = specBuckets[bIdx]!;
        const freshCamp = (await store.getCampaign(campaignId))!;

        if (freshCamp.activeBucketId !== bucket.id) {
          const allIslands = await store.listIslands(campaignId);
          for (const islRec of allIslands) {
            await store.updateIslandProgress(lease, {
              campaignId,
              islandId: islRec.islandId,
              consecutiveNoGainGenerations: 0,
              consecutivePathologyRuns: 0,
              lastHypervolume: 0,
              bestRooflineHeadroom: null,
            });
          }
          islandRunEvals.clear();
          islandTrajectories.clear();
          await store.updateCampaignProgress(lease, {
            campaignId,
            status: 'active',
            stagePhase: 'specialist',
            activeBucketId: bucket.id,
          });
        }

        const bucketWindowStart = bIdx * gensPerBucket + 1;
        const bucketWindowEnd = bIdx === specBuckets.length - 1
          ? Math.max(bucketWindowStart, budgets.maxGenerations - 1)
          : bucketWindowStart + gensPerBucket - 1;
        const startGenForBucket = freshCamp.activeBucketId === bucket.id
          ? Math.max(bucketWindowStart, freshCamp.currentGeneration + 1)
          : bucketWindowStart;

        const remainingBucketsAfter = specBuckets.length - 1 - bIdx;
        const maxEvalsForThisBucket = Math.max(
          freshCamp.evaluationsUsed + 1,
          budgets.maxEvaluations - remainingBucketsAfter - 1,
        );

        const stageRes = await runStageGenerations({
          stagePhase: 'specialist',
          bucketId: bucket.id,
          heldOutWorkloadId: bucket.heldOutWorkloadId,
          startGen: startGenForBucket,
          maxGenInclusive: bucketWindowEnd,
          maxEvalsCeiling: maxEvalsForThisBucket,
        });
        maxSpecialistGenUsed = Math.max(maxSpecialistGenUsed, bucketWindowEnd);
        if (stageRes === 'paused') {
          break;
        }
      }
    }

    const afterSpecCamp = (await store.getCampaign(campaignId))!;
    if (afterSpecCamp.status !== 'paused' && !opts.signal?.aborted) {
      const winningSpecialists: Array<{ readonly bucketId: string; readonly individual: IndividualRecord }> = [];
      let missingBucketWinner = false;
      for (const bucket of specBuckets) {
        const passedInBucket = await store.listIndividuals(campaignId, {
          status: ['passed'],
          bucketId: bucket.id,
        });
        if (passedInBucket.length === 0) {
          missingBucketWinner = true;
          break;
        }
        const sorted = [...passedInBucket].sort((a, b) => {
          const ra = a.paretoRank ?? Number.MAX_SAFE_INTEGER;
          const rb = b.paretoRank ?? Number.MAX_SAFE_INTEGER;
          if (ra !== rb) return ra - rb;
          return (b.scalarFitness ?? 0) - (a.scalarFitness ?? 0);
        });
        winningSpecialists.push({ bucketId: bucket.id, individual: sorted[0]! });
      }

      if (missingBucketWinner || afterSpecCamp.evaluationsUsed >= budgets.maxEvaluations) {
        await store.updateCampaignProgress(lease, { campaignId, status: 'failed' });
      } else {
        const portfolioGen = Math.max(maxSpecialistGenUsed + 1, afterSpecCamp.currentGeneration + 1);
        await store.updateCampaignProgress(lease, {
          campaignId,
          status: 'active',
          stagePhase: 'portfolio',
          activeBucketId: portfolioWorkloadId,
        });

        const islandsList = await store.listIslands(campaignId);
        const isl0 = islandsList[0]!;
        const portfolioTeamPatch = await loadValidatedActiveTeamPatch(isl0.activeTeamConfigId);
        const portfolioId = sanitizeRunId(`ind-portfolio-g${portfolioGen}-${randomBytes(3).toString('hex')}`);
        const childRunDir = join(store.campaignRoot, 'runs', portfolioId);
        await mkdir(childRunDir, { recursive: true, mode: 0o700 });

        const specialistInputs: PortfolioSpecialistContextInput[] = [];
        const sampledPortfolioMembers: SampledParentEntry[] = [];
        for (const entry of winningSpecialists) {
          const specWinner = entry.individual;
          const codeBytes = specWinner.codeSliceCasDigest !== null
            ? await store.readCasBlob(specWinner.codeSliceCasDigest.hex)
            : Buffer.from('// specialist\n', 'utf8');
          specialistInputs.push({
            bucketId: entry.bucketId,
            individual: specWinner,
            codeSlice: codeBytes.toString('utf8'),
          });
          sampledPortfolioMembers.push({
            individual: specWinner,
            role: 'portfolio_member',
            sourceIslandId: specWinner.islandId,
            weight: 1,
          });
        }

        const stagedPortfolioCtx = await stagePortfolioSpecialistContextFiles({
          stagingDir: join(childRunDir, 'portfolio-specialists'),
          specialists: specialistInputs,
          scrubber,
        });

        const arms = await store.listModelBanditArms(campaignId);
        const modelPick = selectModelCandidate({
          strategy: sampling.modelBandit,
          modelIds,
          arms,
          sequenceIndex: sequenceCounter,
        });

        const portfolioTrackId = winningSpecialists[0]?.individual.trackId ?? declaredTracks[0] ?? 'cuda_raw';
        const portfolioOutcome = await evaluator({
          campaignId,
          individualId: portfolioId,
          islandId: isl0.islandId,
          generation: portfolioGen,
          stagePhase: 'portfolio',
          bucketId: portfolioWorkloadId,
          heldOutWorkloadId: portfolioWorkloadId,
          modelId: modelPick.modelId,
          trackId: portfolioTrackId,
          mutationKind: 'portfolio',
          teamConfigId: isl0.activeTeamConfigId,
          parents: sampledPortfolioMembers,
          stagedParentFiles: stagedPortfolioCtx.files,
          portfolioSpecialists: winningSpecialists.map(w => w.individual),
          campaignRoot: store.campaignRoot,
          childRunDir,
          baseRevision: afterSpecCamp.baseRevision,
          manifest,
          taskpack,
          ...(portfolioTeamPatch !== undefined ? { teamPatch: portfolioTeamPatch } : {}),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        });

        const codeCas = await store.writeCasBlob(
          Buffer.from(portfolioOutcome.codeSlice.length > 0 ? portfolioOutcome.codeSlice : '// portfolio\n', 'utf8'),
        );
        let vrDigest: Digest | null = null;
        if (portfolioOutcome.rawVerdictReceiptBytes !== undefined) {
          vrDigest = (await store.writeCasBlob(portfolioOutcome.rawVerdictReceiptBytes)).digest;
        }
        const storedPortfolioArts: ArtifactRef[] = [];
        if (portfolioOutcome.stageABlobs !== undefined && portfolioOutcome.stageABlobs.length > 0) {
          for (const blob of portfolioOutcome.stageABlobs) {
            const wb = await store.writeCasBlob(blob.bytes);
            storedPortfolioArts.push({
              name: blob.name,
              digest: wb.digest,
              byteLength: wb.byteLength,
              ...(blob.mediaType !== undefined && blob.mediaType !== null ? { mediaType: blob.mediaType } : {}),
            });
          }
        } else if (portfolioOutcome.outputArtifacts !== undefined) {
          storedPortfolioArts.push(...portfolioOutcome.outputArtifacts);
        }

        const portfolioNiche = portfolioOutcome.status === 'passed'
          ? computeNicheKey(population.nicheAxes, portfolioOutcome.metrics, portfolioOutcome.hardwareDiagnostics)
          : null;

        await store.recordIndividual(lease, {
          individualId: portfolioId,
          campaignId,
          islandId: isl0.islandId,
          generation: portfolioGen,
          bucketId: portfolioWorkloadId,
          teamConfigId: isl0.activeTeamConfigId,
          modelId: modelPick.modelId,
          trackId: portfolioTrackId,
          mutationKind: 'portfolio',
          status: portfolioOutcome.status,
          failureReason: portfolioOutcome.failureReason ?? null,
          nicheKey: portfolioNiche,
          paretoRank: portfolioOutcome.status === 'passed' ? 1 : null,
          crowdingDistance: portfolioOutcome.status === 'passed' ? Number.POSITIVE_INFINITY : null,
          scalarFitness: portfolioOutcome.status === 'passed' ? 1.0 : null,
          codeSliceCasDigest: codeCas.digest,
          evidenceDigest: portfolioOutcome.evidenceDigest ?? null,
          verdictReceiptCasDigest: vrDigest,
          outputArtifacts: storedPortfolioArts,
          metrics: portfolioOutcome.metrics,
          ...(portfolioOutcome.bucketMetrics !== undefined ? { bucketMetrics: portfolioOutcome.bucketMetrics } : {}),
          ...(portfolioOutcome.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: portfolioOutcome.hardwareDiagnostics } : {}),
          ...(portfolioOutcome.hardwareProvenance !== undefined ? { hardwareProvenance: portfolioOutcome.hardwareProvenance } : {}),
          ...(portfolioOutcome.findings !== undefined ? { findings: portfolioOutcome.findings } : {}),
          lineageEdges: winningSpecialists.map(sw => ({
            campaignId,
            childIndividualId: portfolioId,
            parentIndividualId: sw.individual.individualId,
            role: 'portfolio_member' as const,
            sourceIslandId: sw.individual.islandId,
            createdGeneration: portfolioGen,
          })),
        });

        await refreshStageParetoArchive(store, lease, campaignId, portfolioWorkloadId, objectives);
        await store.updateCampaignProgress(lease, {
          campaignId,
          status: portfolioOutcome.status === 'passed' ? 'completed' : 'failed',
          stagePhase: 'portfolio',
          activeBucketId: portfolioWorkloadId,
          currentGeneration: portfolioGen,
        });
      }
    }
  }

  const finalCampaign = (await store.getCampaign(campaignId))!;
  const finalIslands = await store.listIslands(campaignId);
  const allPassed = await store.listIndividuals(campaignId, { status: ['passed'] });
  const paretoFrontier = allPassed.filter(ind => ind.paretoRank === 1);

  let exportedBundle: ExportEvolutionBundleResult | undefined;
  if (finalCampaign.status === 'completed' && manifest.spec.export !== undefined && opts.autoExport) {
    const rawOutDir = manifest.spec.export.outputDir;
    const resolvedOutDir = isAbsolute(rawOutDir)
      ? rawOutDir
      : resolve(opts.repositoryRoot ?? store.campaignRoot, rawOutDir);
    const effectiveDriverConstraint = opts.driverConstraint ?? finalCampaign.driverConstraint ?? undefined;
    exportedBundle = await exportEvolutionBundle({
      store,
      campaignId,
      outputDir: resolvedOutDir,
      format: opts.exportFormat ?? manifest.spec.export.format,
      allowSyntheticProbe: opts.allowSyntheticProbe,
      ...(effectiveDriverConstraint !== undefined ? { driverConstraint: effectiveDriverConstraint } : {}),
      ...(opts.receiptSigningSecret !== undefined ? { receiptSigningSecret: opts.receiptSigningSecret } : {}),
      ...(opts.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: opts.verifyReceiptSignature } : {}),
      ...(opts.dispatchManifest !== undefined ? { dispatchManifest: opts.dispatchManifest } : {}),
      scrubber,
    });
  }

  return Object.freeze({
    store,
    campaign: finalCampaign,
    islands: Object.freeze(finalIslands),
    paretoFrontier: Object.freeze(paretoFrontier),
    noveltyRejectionsCount,
    cascadeSoftStopsCount,
    advisoryDecisions: Object.freeze(advisoryDecisions),
    earlyStoppedByRoofline,
    ...(exportedBundle !== undefined ? { exportedBundle } : {}),
  });
}

function resolveCampaignEvaluator(
  evaluator: CandidateEvaluator | undefined,
  controllerOptions: ControllerChildRunEvaluatorOptions | undefined,
): CandidateEvaluator {
  if (evaluator !== undefined) return evaluator;
  if (controllerOptions !== undefined) {
    return createControllerChildRunEvaluator(controllerOptions);
  }
  throw new EvolutionError(
    'EVOLUTION_SCHEMA_INVALID',
    'either evaluator or controllerEvaluatorOptions must be provided to execute candidate runs',
  );
}

/**
 * Create and run an evolutionary optimization campaign inside `<campaignRoot>/campaign.sqlite`.
 */
export async function runEvolutionCampaign(
  options: RunEvolutionCampaignOptions,
): Promise<RunEvolutionCampaignResult> {
  const scrubber = options.scrubber ?? DEFAULT_CAMPAIGN_SCRUBBER;
  const effectiveRepoRoot = options.repositoryRoot ?? options.controllerEvaluatorOptions?.repositoryRoot;
  await assertDisjointCampaignAndRepositoryRoots(options.campaignRoot, effectiveRepoRoot);

  const checked = await checkEvolutionCampaign({
    ...(options.manifestPath !== undefined ? { manifestPath: options.manifestPath } : {}),
    ...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(effectiveRepoRoot !== undefined ? { repositoryRoot: effectiveRepoRoot } : {}),
    ...(options.taskpack !== undefined ? { taskpack: options.taskpack } : {}),
    scrubber,
  });

  if (options.manifestPath !== undefined && effectiveRepoRoot === undefined) {
    await assertDisjointCampaignAndRepositoryRoots(options.campaignRoot, dirname(resolve(options.manifestPath)));
  }

  const evaluator = resolveCampaignEvaluator(options.evaluator, options.controllerEvaluatorOptions);
  const campaignId = options.campaignId ?? `camp-${checked.manifest.metadata.name}-${randomBytes(4).toString('hex')}`;
  const baseRevision = options.baseRevision ?? resolveGitHeadRevision(effectiveRepoRoot);
  const { lockHash, baseTaskContract } = await computeBaselineCampaignLockHash(
    checked.taskpack,
    campaignId,
    baseRevision,
    effectiveRepoRoot,
  );
  const driverConstraint = resolveTargetDriverConstraint(checked.taskpack, checked.targetCellId);

  const store = await EvolutionCampaignStore.open({
    campaignRoot: options.campaignRoot,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    createIfMissing: true,
  });

  try {
    const lease = await store.acquireLease(`coordinator-${randomBytes(6).toString('hex')}`);
    const initialStagePhase: CampaignStagePhase = checked.manifest.spec.stages.mode === 'specialist-then-portfolio'
      ? 'specialist'
      : 'single-target';
    const initialBucketId = checked.manifest.spec.stages.mode === 'specialist-then-portfolio'
      ? checked.manifest.spec.stages.specialistBuckets[0]!.id
      : null;

    await store.createCampaign(lease, {
      campaignId,
      manifest: checked.manifest,
      manifestDigest: checked.manifestDigest,
      baseRevision,
      lockHash,
      driverConstraint,
      stagePhase: initialStagePhase,
      activeBucketId: initialBucketId,
      modelIds: checked.modelIds,
    });

    await store.ensureModelBanditArms(lease, campaignId, checked.modelIds);

    return await driveCampaignExecution({
      store,
      lease,
      campaignId,
      manifest: checked.manifest,
      taskpack: checked.taskpack,
      baseTaskContract,
      modelIds: checked.modelIds,
      driverConstraint,
      ...(effectiveRepoRoot !== undefined ? { repositoryRoot: effectiveRepoRoot } : {}),
      evaluator,
      ...(options.proposeCandidateSlice !== undefined ? { proposeCandidateSlice: options.proposeCandidateSlice } : {}),
      ...(options.supervisorRunner !== undefined ? { supervisorRunner: options.supervisorRunner } : {}),
      ...(options.decisionPolicy !== undefined
        ? { decisionPolicy: options.decisionPolicy }
        : (options.controllerEvaluatorOptions?.decisionPolicy !== undefined
          ? { decisionPolicy: options.controllerEvaluatorOptions.decisionPolicy }
          : {})),
      ...(options.decisionTransport !== undefined
        ? { decisionTransport: options.decisionTransport }
        : (options.controllerEvaluatorOptions?.decisionTransport !== undefined
          ? { decisionTransport: options.controllerEvaluatorOptions.decisionTransport }
          : {})),
      ...(options.decisionApiKey !== undefined
        ? { decisionApiKey: options.decisionApiKey }
        : (options.controllerEvaluatorOptions?.decisionApiKey !== undefined
          ? { decisionApiKey: options.controllerEvaluatorOptions.decisionApiKey }
          : {})),
      ...(options.environment !== undefined
        ? { environment: options.environment }
        : (options.controllerEvaluatorOptions?.environment !== undefined
          ? { environment: options.controllerEvaluatorOptions.environment }
          : {})),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      autoExport: options.autoExport ?? true,
      ...(options.exportFormat !== undefined ? { exportFormat: options.exportFormat } : {}),
      allowSyntheticProbe: options.allowSyntheticProbe === true,
      ...(options.receiptSigningSecret !== undefined ? { receiptSigningSecret: options.receiptSigningSecret } : {}),
      ...(options.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: options.verifyReceiptSignature } : {}),
      ...(options.dispatchManifest !== undefined ? { dispatchManifest: options.dispatchManifest } : {}),
      scrubber,
    });
  } catch (err: unknown) {
    await store.close().catch(() => undefined);
    throw err;
  }
}

/**
 * Resume an existing paused or interrupted campaign from `<campaignRoot>/campaign.sqlite`
 * under a newly fenced coordinator lease without double-counting `maxEvaluations` or `trial_used_generations`.
 */
export async function resumeEvolutionCampaign(
  options: ResumeEvolutionCampaignOptions,
): Promise<RunEvolutionCampaignResult> {
  const scrubber = options.scrubber ?? DEFAULT_CAMPAIGN_SCRUBBER;
  const effectiveRepoRoot = options.repositoryRoot ?? options.controllerEvaluatorOptions?.repositoryRoot;
  await assertDisjointCampaignAndRepositoryRoots(options.campaignRoot, effectiveRepoRoot);

  const evaluator = resolveCampaignEvaluator(options.evaluator, options.controllerEvaluatorOptions);

  const store = await EvolutionCampaignStore.open({
    campaignRoot: options.campaignRoot,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    createIfMissing: false,
  });

  try {
    const lease = await store.acquireLease(`resume-coordinator-${randomBytes(6).toString('hex')}`);

    let existingCampaign: CampaignRecord | null;
    if (options.campaignId !== undefined) {
      existingCampaign = await store.getCampaign(options.campaignId);
    } else {
      const all = await store.listCampaigns();
      existingCampaign = all[0] ?? null;
    }
    if (existingCampaign === null) {
      throw new EvolutionError('EVOLUTION_NOT_FOUND', 'no campaign found to resume in campaign.sqlite');
    }

    if (existingCampaign.status === 'completed') {
      const islands = await store.listIslands(existingCampaign.campaignId);
      const allPassed = await store.listIndividuals(existingCampaign.campaignId, { status: ['passed'] });
      return Object.freeze({
        store,
        campaign: existingCampaign,
        islands: Object.freeze(islands),
        paretoFrontier: Object.freeze(allPassed.filter(i => i.paretoRank === 1)),
        noveltyRejectionsCount: 0,
        cascadeSoftStopsCount: 0,
        advisoryDecisions: Object.freeze([]),
        earlyStoppedByRoofline: false,
      });
    }

    const checked = await checkEvolutionCampaign({
      manifest: existingCampaign.manifest,
      ...(effectiveRepoRoot !== undefined ? { repositoryRoot: effectiveRepoRoot } : {}),
      ...(options.taskpack !== undefined ? { taskpack: options.taskpack } : {}),
      scrubber,
    });

    const { baseTaskContract } = await computeBaselineCampaignLockHash(
      checked.taskpack,
      existingCampaign.campaignId,
      existingCampaign.baseRevision,
      effectiveRepoRoot,
    );
    const driverConstraint = resolveTargetDriverConstraint(checked.taskpack, checked.targetCellId)
      ?? existingCampaign.driverConstraint;

    await store.ensureModelBanditArms(lease, existingCampaign.campaignId, checked.modelIds);
    await store.updateCampaignProgress(lease, {
      campaignId: existingCampaign.campaignId,
      status: 'active',
      ...(driverConstraint !== null ? { driverConstraint } : {}),
    });

    return await driveCampaignExecution({
      store,
      lease,
      campaignId: existingCampaign.campaignId,
      manifest: existingCampaign.manifest,
      taskpack: checked.taskpack,
      baseTaskContract,
      modelIds: checked.modelIds,
      driverConstraint,
      ...(effectiveRepoRoot !== undefined ? { repositoryRoot: effectiveRepoRoot } : {}),
      evaluator,
      ...(options.proposeCandidateSlice !== undefined ? { proposeCandidateSlice: options.proposeCandidateSlice } : {}),
      ...(options.supervisorRunner !== undefined ? { supervisorRunner: options.supervisorRunner } : {}),
      ...(options.decisionPolicy !== undefined
        ? { decisionPolicy: options.decisionPolicy }
        : (options.controllerEvaluatorOptions?.decisionPolicy !== undefined
          ? { decisionPolicy: options.controllerEvaluatorOptions.decisionPolicy }
          : {})),
      ...(options.decisionTransport !== undefined
        ? { decisionTransport: options.decisionTransport }
        : (options.controllerEvaluatorOptions?.decisionTransport !== undefined
          ? { decisionTransport: options.controllerEvaluatorOptions.decisionTransport }
          : {})),
      ...(options.decisionApiKey !== undefined
        ? { decisionApiKey: options.decisionApiKey }
        : (options.controllerEvaluatorOptions?.decisionApiKey !== undefined
          ? { decisionApiKey: options.controllerEvaluatorOptions.decisionApiKey }
          : {})),
      ...(options.environment !== undefined
        ? { environment: options.environment }
        : (options.controllerEvaluatorOptions?.environment !== undefined
          ? { environment: options.controllerEvaluatorOptions.environment }
          : {})),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      autoExport: options.autoExport ?? true,
      ...(options.exportFormat !== undefined ? { exportFormat: options.exportFormat } : {}),
      allowSyntheticProbe: options.allowSyntheticProbe === true,
      ...(options.receiptSigningSecret !== undefined ? { receiptSigningSecret: options.receiptSigningSecret } : {}),
      ...(options.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: options.verifyReceiptSignature } : {}),
      ...(options.dispatchManifest !== undefined ? { dispatchManifest: options.dispatchManifest } : {}),
      scrubber,
    });
  } catch (err: unknown) {
    await store.close().catch(() => undefined);
    throw err;
  }
}

async function withReadStore<T>(
  options: {
    readonly campaignRoot: string;
    readonly store?: EvolutionCampaignStore | undefined;
    readonly clock?: CampaignClockSource | undefined;
  },
  fn: (store: EvolutionCampaignStore) => Promise<T>,
): Promise<T> {
  if (options.store !== undefined) {
    return fn(options.store);
  }
  const opened = await EvolutionCampaignStore.open({
    campaignRoot: options.campaignRoot,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    createIfMissing: false,
  });
  try {
    return await fn(opened);
  } finally {
    await opened.close();
  }
}

async function resolveTargetCampaign(
  store: EvolutionCampaignStore,
  campaignId: string | undefined,
): Promise<CampaignRecord> {
  if (campaignId !== undefined) {
    const found = await store.getCampaign(campaignId);
    if (found === null) {
      throw new EvolutionError('EVOLUTION_NOT_FOUND', `campaign "${campaignId}" not found`);
    }
    return found;
  }
  const list = await store.listCampaigns();
  if (list.length === 0) {
    throw new EvolutionError('EVOLUTION_NOT_FOUND', 'no campaigns found in campaign.sqlite');
  }
  return list[0]!;
}

/**
 * Read concise campaign status, counts by status, active teams, and Pareto frontier for CLI `status`.
 */
export async function getEvolutionCampaignStatus(
  options: GetEvolutionCampaignStatusOptions,
): Promise<EvolutionCampaignStatus> {
  return withReadStore(options, async store => {
    const campaign = await resolveTargetCampaign(store, options.campaignId);
    const islands = await store.listIslands(campaign.campaignId);
    const individuals = await store.listIndividuals(campaign.campaignId);
    const allTeams = await store.listTeamConfigs(campaign.campaignId);
    const activeTeamIds = new Set(islands.map(i => i.activeTeamConfigId));
    const activeTeams = allTeams.filter(tc => activeTeamIds.has(tc.teamConfigId));
    const latestScratchpad = await store.getLatestScratchpadSnapshot(campaign.campaignId);

    let passed = 0;
    let softPassed = 0;
    let failed = 0;
    let preempted = 0;
    let noveltyRejected = 0;

    for (const ind of individuals) {
      if (ind.status === 'passed') passed += 1;
      else if (ind.status === 'soft_passed') softPassed += 1;
      else if (ind.status === 'preempted') preempted += 1;
      else {
        failed += 1;
        if (ind.failureReason === 'NOVELTY_CLONE_REJECTED') noveltyRejected += 1;
      }
    }

    const paretoFrontier = individuals.filter(ind => ind.status === 'passed' && ind.paretoRank === 1);

    return Object.freeze({
      campaign,
      islands: Object.freeze(islands),
      paretoFrontier: Object.freeze(paretoFrontier),
      countsByStatus: Object.freeze({
        passed,
        soft_passed: softPassed,
        failed,
        preempted,
        noveltyRejected,
      }),
      activeTeams: Object.freeze(activeTeams),
      latestScratchpad,
    });
  });
}

/**
 * Read complete campaign archive, MAP-Elites niche grids, `team_configs` history, lineage DAG,
 * model bandit arms, and scratchpads for CLI `inspect`.
 */
export async function inspectEvolutionCampaign(
  options: InspectEvolutionCampaignOptions,
): Promise<EvolutionCampaignInspection> {
  return withReadStore(options, async store => {
    const campaign = await resolveTargetCampaign(store, options.campaignId);
    const islands = await store.listIslands(campaign.campaignId);
    const individuals = await store.listIndividuals(campaign.campaignId);
    const teamConfigs = await store.listTeamConfigs(campaign.campaignId);
    const lineageEdges = await store.listLineageEdges(campaign.campaignId);
    const modelBanditArms = await store.listModelBanditArms(campaign.campaignId);
    const scratchpadSnapshots = await store.listScratchpadSnapshots(campaign.campaignId);

    const bucketTargets: readonly (string | null)[] = campaign.manifest.spec.stages.mode === 'specialist-then-portfolio'
      ? [
        ...campaign.manifest.spec.stages.specialistBuckets.map(b => b.id),
        campaign.manifest.spec.stages.portfolioHeldOutWorkloadId,
      ]
      : [null];

    const nicheArchives: IslandNicheArchiveView[] = [];
    for (const isl of islands) {
      for (const bId of bucketTargets) {
        const nicheMap = await store.getIslandNicheElites(campaign.campaignId, isl.islandId, bId);
        nicheArchives.push(
          Object.freeze({
            islandId: isl.islandId,
            bucketId: bId,
            elites: Object.freeze([...nicheMap.values()]),
          }),
        );
      }
    }

    const paretoFrontier = individuals.filter(ind => ind.status === 'passed' && ind.paretoRank === 1);

    return Object.freeze({
      campaign,
      islands: Object.freeze(islands),
      paretoFrontier: Object.freeze(paretoFrontier),
      nicheArchives: Object.freeze(nicheArchives),
      teamConfigs: Object.freeze(teamConfigs),
      individuals: Object.freeze(individuals),
      lineageEdges: Object.freeze(lineageEdges),
      modelBanditArms: Object.freeze(modelBanditArms),
      scratchpadSnapshots: Object.freeze(scratchpadSnapshots),
    });
  });
}
