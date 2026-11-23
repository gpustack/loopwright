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
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  DecisionBudgetTracker,
  DEFAULT_DECISION_POLICY,
  evaluateCascadeEscalation,
  evaluateMutationNovelty,
  routeEvolutionStrategy,
  type DecisionCascadeEscalationResult,
  type DecisionEvolutionStrategyResult,
  type DecisionHardwareDiagnostics,
  type DecisionMutationNoveltyHistoryEntry,
  type DecisionMutationNoveltyResult,
} from '@loopwright/decisions';
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
  type ParentContextInput,
  type SampledParentEntry,
  type StagedParentContextFile,
} from './sampler.js';
import {
  canonicalizeJson,
  loadEvolutionCampaignFile,
  parseBucketMetricsJson,
  parseEvolutionCampaignDocument,
  parseHardwareDiagnosticsJson,
  parseHardwareProvenanceJson,
  parseMetricsRecordJson,
  parseStructuredFindingsJson,
  parseTeamPatchV1,
} from './schema.js';
import { synthesizeCampaignScratchpad } from './scratchpad.js';
import { EvolutionCampaignStore } from './store.js';
import {
  hasRunEvalLoopPathology,
  recordTeamTrialOutcome,
  runPlateauSupervisorTurn,
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

export interface CandidateEvaluationProposal extends CandidateProposalContext {
  readonly campaignRoot: string;
  readonly childRunDir: string;
  readonly baseRevision: string;
  readonly manifest: EvolutionCampaignManifest;
  readonly taskpack: TaskpackManifest;
  readonly teamPatch?: TeamPatchV1 | undefined;
  readonly proposedCodeSlice?: string | undefined;
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
  readonly clock?: CampaignClockSource | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly autoExport?: boolean | undefined;
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
  readonly clock?: CampaignClockSource | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly autoExport?: boolean | undefined;
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

function sha256Digest(bytes: Uint8Array | string): Digest {
  return Object.freeze({
    algorithm: 'sha256' as const,
    hex: createHash('sha256').update(bytes).digest('hex'),
  });
}

function sanitizeRunId(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, LIMITS.identifier);
  return cleaned.length > 0 ? cleaned : `ind-${randomBytes(4).toString('hex')}`;
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

async function copyDirectoryNoFollow(srcDir: string, dstDir: string): Promise<void> {
  const srcStat = await lstat(srcDir);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `source directory must be a non-symlink directory: "${srcDir}"`);
  }
  await mkdir(dstDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(srcDir, entry.name);
    const dstChild = join(dstDir, entry.name);
    const st = await lstat(srcChild);
    if (st.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden inside repository tree: "${srcChild}"`);
    }
    if (st.isDirectory()) {
      await copyDirectoryNoFollow(srcChild, dstChild);
    } else if (st.isFile()) {
      const bytes = await readFile(srcChild);
      const execBit = (st.mode & 0o111) !== 0;
      const mode = execBit ? 0o755 : 0o644;
      await writeFile(dstChild, bytes, { mode });
      if (execBit) await chmod(dstChild, 0o755);
    }
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

function extractEvolveBlocksFromSource(text: string): string {
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

function buildStageScopedTaskpack(
  baseTaskpack: TaskpackManifest,
  heldOutWorkloadId: string,
  teamPatch: TeamPatchV1 | undefined,
): TaskpackManifest {
  const updatedGates = baseTaskpack.spec.verification.externalGates.map(gate => {
    if (gate.implementation !== 'benchmark-gate.v1') return gate;
    return {
      ...gate,
      heldOutWorkloadId,
    };
  });

  let roles = baseTaskpack.spec.roles;
  let steps = baseTaskpack.spec.steps;

  if (teamPatch !== undefined) {
    const baseRoleById = new Map((baseTaskpack.spec.roles ?? []).map(r => [r.id, r] as const));
    const firstModel = baseTaskpack.spec.models?.[0];
    const mappedRoles: TaskpackRoleDeclaration[] = teamPatch.roles.map(pr => {
      const arch = baseRoleById.get(pr.archetypeRoleId);
      return {
        id: pr.id,
        provider: arch?.provider ?? firstModel?.provider ?? 'delegated',
        model: pr.model ?? arch?.model ?? firstModel?.id ?? 'default',
        thinking: arch?.thinking ?? firstModel?.thinking ?? 'medium',
        purpose: pr.purpose,
        prompt: pr.prompt,
        tools: [...pr.tools] as TaskpackToolName[],
        ...(pr.resourceIds !== undefined ? { resourceIds: [...pr.resourceIds] } : {}),
      };
    });

    const mappedAgentSteps: TaskpackStepDeclaration[] = teamPatch.steps.map(ps => ({
      id: ps.id,
      kind: 'agent',
      role: ps.roleId,
      dependsOn: [...ps.dependsOn],
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
      ...(roles !== undefined ? { roles } : {}),
      ...(steps !== undefined ? { steps } : {}),
      verification: {
        ...baseTaskpack.spec.verification,
        externalGates: updatedGates,
      },
    },
  };
}

function collectReferencedEnvNames(credentialEnvMap: HostCredentialEnvMap | undefined): readonly string[] {
  if (credentialEnvMap === undefined) return [];
  const names = new Set<string>();
  for (const raw of [
    credentialEnvMap.provider,
    credentialEnvMap.gate,
    credentialEnvMap.gateAuth,
    credentialEnvMap.localCommandGate,
    credentialEnvMap.publication,
    credentialEnvMap.publicationAuth,
  ]) {
    if (typeof raw === 'string' && raw.length > 0) names.add(raw);
  }
  if (credentialEnvMap.byCredentialRef !== undefined) {
    for (const val of Object.values(credentialEnvMap.byCredentialRef)) {
      if (typeof val === 'string' && val.length > 0) names.add(val);
    }
  }
  if (credentialEnvMap.byProvider !== undefined) {
    for (const val of Object.values(credentialEnvMap.byProvider)) {
      if (typeof val === 'string' && val.length > 0) names.add(val);
    }
  }
  return [...names];
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
    await copyDirectoryNoFollow(realBaseRepo, childRepoDir);

    const realTmpRoot = await realpath(tmpdir());
    const trustedTempDir = await mkdtemp(join(realTmpRoot, 'lw-evo-trusted-reg-'));
    await chmod(trustedTempDir, 0o700);

    // Temporarily mirror any custom envLookup credential bindings onto process.env during loadTrustedConfiguration
    const restoredEnvKeys: Array<{ readonly key: string; readonly previous: string | undefined }> = [];
    for (const envName of collectReferencedEnvNames(options.credentialEnvMap)) {
      const resolvedVal = envLookup(envName);
      if (resolvedVal !== undefined && process.env[envName] !== resolvedVal) {
        restoredEnvKeys.push({ key: envName, previous: process.env[envName] });
        process.env[envName] = resolvedVal;
      }
    }

    try {
      const scopedTaskpack = buildStageScopedTaskpack(
        proposal.taskpack,
        proposal.heldOutWorkloadId,
        proposal.teamPatch,
      );

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

      const finalRegistryObj = extraRegistryResources.length > 0
        ? {
          ...compiled.registry,
          spec: {
            ...compiled.registry.spec,
            resources: [...compiled.registry.spec.resources, ...extraRegistryResources],
          },
        }
        : compiled.registry;

      const registryBytes = Buffer.from(`${JSON.stringify(finalRegistryObj, null, 2)}\n`, 'utf8');
      const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');
      const registryPath = join(trustedTempDir, 'registry.json');
      await writeFile(registryPath, registryBytes, { mode: 0o600 });
      await chmod(registryPath, 0o600);

      const finalTaskObj = extraRegistryResources.length > 0
        ? {
          ...compiled.config.spec.task,
          spec: {
            ...compiled.config.spec.task.spec,
            trustedContext: {
              ...compiled.config.spec.task.spec.trustedContext,
              resources: [...compiled.config.spec.task.spec.trustedContext.resources, ...extraRegistryResources],
            },
          },
        }
        : compiled.config.spec.task;

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
      });
      if (!loadedRes.ok) {
        throw new EvolutionError(
          'EVOLUTION_STORE_ERROR',
          `child run loadTrustedConfiguration failed: ${loadedRes.error.code} (${loadedRes.error.path})`,
        );
      }

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

        const submitRes = await stepSubmit({
          runRoot: controllerRunRoot,
          runId,
          leaseToken: tick.leaseToken,
          ...(stepOut?.submissionFile !== undefined ? { submissionFile: stepOut.submissionFile } : {}),
          ...(stepOut?.verdict !== undefined ? { verdict: stepOut.verdict } : {}),
          status: stepOut?.status ?? 'completed',
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

      const evolveGuardDecl = scopedTaskpack.spec.verification.localChecks.find(
        c => c.implementation === 'evolve-block-guard.v1',
      );
      const guardedFiles = Array.isArray(evolveGuardDecl?.parameters?.['files'])
        ? (evolveGuardDecl.parameters['files'] as readonly string[])
        : [];
      let extractedCodeSlice = proposal.proposedCodeSlice ?? '';
      if (guardedFiles.length > 0) {
        const slices: string[] = [];
        for (const rel of guardedFiles) {
          const candidatePath = join(latestWorkspacePath, rel);
          const fallbackPath = join(childRepoDir, rel);
          const content = await readFile(candidatePath, 'utf8').catch(() => readFile(fallbackPath, 'utf8').catch(() => ''));
          if (content.length > 0) {
            slices.push(extractEvolveBlocksFromSource(content));
          }
        }
        if (slices.length > 0) {
          extractedCodeSlice = slices.join('\n');
        }
      }
      if (extractedCodeSlice.length === 0) {
        extractedCodeSlice = `// individual:${proposal.individualId}\n`;
      }

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
      const artifactNames = await readdir(artifactsDir).catch(() => [] as string[]);
      const benchProofFiles = artifactNames
        .filter(n => n.startsWith('benchmark-producer-') && n.endsWith('.proof.json'))
        .sort();

      let rawVerdictReceiptBytes: Uint8Array | undefined;
      let metrics: Readonly<Record<string, number>> = Object.freeze({});
      let bucketMetrics: readonly BucketMetricEntry[] | undefined;
      let hardwareDiagnostics: HardwareDiagnostics | undefined;
      let hardwareProvenance: HardwareProvenance | undefined;
      let findings: readonly StructuredFinding[] | undefined;
      let outputArtifacts: readonly ArtifactRef[] = Object.freeze([]);
      const stageABlobs: StageABlobPayload[] = [];
      let dispReason: string | null = null;
      let retryablePreemption = false;

      if (benchProofFiles.length > 0) {
        const latestProofFile = join(artifactsDir, benchProofFiles[benchProofFiles.length - 1]!);
        const proofJson = JSON.parse(await readFile(latestProofFile, 'utf8')) as Record<string, unknown>;
        const outputRef = proofJson['output'] as { readonly name?: string } | undefined;
        const outputName = outputRef?.name;
        const benchJson: Record<string, unknown> = typeof outputName === 'string' && !outputName.includes('/') && !outputName.includes('..')
          ? (JSON.parse(await readFile(join(artifactsDir, outputName), 'utf8')) as Record<string, unknown>)
          : {};
        const verdictObj = benchJson['verdict'] as Record<string, unknown> | null | undefined;
        const dispObj = benchJson['disposition'] as Record<string, unknown> | undefined;
        const responseB64 = benchJson['responseBytes'];
        const responseSigRaw = benchJson['responseSignature'];

        if (typeof responseB64 === 'string' && responseB64.length > 0) {
          const decodedBytes = Buffer.from(responseB64, 'base64');
          if (typeof responseSigRaw === 'string' && responseSigRaw.length > 0) {
            const sigHex = responseSigRaw.startsWith('sha256=') ? responseSigRaw.slice(7) : responseSigRaw;
            const parsedResp = JSON.parse(decodedBytes.toString('utf8')) as Record<string, unknown>;
            rawVerdictReceiptBytes = Buffer.from(`${canonicalizeJson({ ...parsedResp, signature: sigHex })}\n`, 'utf8');
          } else {
            rawVerdictReceiptBytes = decodedBytes;
          }
        }
        if (dispObj !== undefined && typeof dispObj['reason'] === 'string') {
          dispReason = dispObj['reason'];
        }
        if (dispObj?.['retryablePreemption'] === true || dispReason === 'BENCHMARK_PREEMPTED') {
          retryablePreemption = true;
        }

        if (verdictObj !== null && verdictObj !== undefined) {
          if (verdictObj['metrics'] !== undefined) {
            metrics = parseMetricsRecordJson(verdictObj['metrics'] as Readonly<Record<string, number>>);
          }
          if (verdictObj['bucketMetrics'] !== undefined) {
            bucketMetrics = parseBucketMetricsJson(verdictObj['bucketMetrics'] as readonly BucketMetricEntry[], scrubber);
          }
          if (verdictObj['hardwareDiagnostics'] !== undefined) {
            hardwareDiagnostics = parseHardwareDiagnosticsJson(verdictObj['hardwareDiagnostics'] as HardwareDiagnostics, scrubber);
          }
          if (verdictObj['hardwareProvenance'] !== undefined) {
            hardwareProvenance = parseHardwareProvenanceJson(verdictObj['hardwareProvenance'] as HardwareProvenance);
          }
          if (verdictObj['findings'] !== undefined) {
            findings = parseStructuredFindingsJson(verdictObj['findings'] as readonly StructuredFinding[], '/findings');
          }
          if (dispReason === null && typeof verdictObj['reason'] === 'string') {
            dispReason = verdictObj['reason'];
          }
          if (Array.isArray(verdictObj['outputArtifacts']) && runSucceeded) {
            const parsedArts: ArtifactRef[] = [];
            for (const rawArt of verdictObj['outputArtifacts'] as Array<Record<string, unknown>>) {
              const name = String(rawArt['name']);
              const digObj = rawArt['digest'] as { readonly algorithm: 'sha256'; readonly hex: string };
              const byteLength = Number(rawArt['byteLength']);
              const mediaType = typeof rawArt['mediaType'] === 'string' ? rawArt['mediaType'] : undefined;
              const casPath = await resolveCanonicalCasBlobPath(artifactsDir, digObj.hex);
              const blobBytes = await readFile(casPath);
              parsedArts.push({
                name,
                digest: { algorithm: 'sha256', hex: digObj.hex },
                byteLength,
                ...(mediaType !== undefined ? { mediaType } : {}),
              });
              stageABlobs.push({
                name,
                bytes: blobBytes,
                digest: { algorithm: 'sha256', hex: digObj.hex },
                byteLength,
                ...(mediaType !== undefined ? { mediaType } : {}),
              });
            }
            outputArtifacts = Object.freeze(parsedArts);
          }
        }
      }

      const childRunRelPath = `runs/${proposal.individualId}/controller/${runId}`;
      let finalStatus: IndividualStatus;
      let failureReason: string | null = null;

      if (retryablePreemption) {
        finalStatus = 'preempted';
        failureReason = 'BENCHMARK_PREEMPTED';
      } else if (runSucceeded) {
        finalStatus = 'passed';
        failureReason = null;
      } else {
        finalStatus = 'failed';
        failureReason = dispReason ?? (benchProofFiles.length === 0 ? 'LOCAL_VERIFICATION_FAILED' : `RUN_${terminalStatusLabel.toUpperCase()}`);
      }

      const evalResult: CandidateEvaluationResult = Object.freeze({
        status: finalStatus,
        failureReason,
        codeSlice: extractedCodeSlice,
        metrics,
        ...(bucketMetrics !== undefined ? { bucketMetrics } : {}),
        ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
        ...(hardwareProvenance !== undefined ? { hardwareProvenance } : {}),
        ...(findings !== undefined ? { findings } : {}),
        outputArtifacts,
        ...(stageABlobs.length > 0 ? { stageABlobs: Object.freeze(stageABlobs) } : {}),
        ...(rawVerdictReceiptBytes !== undefined ? { rawVerdictReceiptBytes } : {}),
        evidenceDigest: runSucceeded ? sha256Digest(`${proposal.individualId}:${runId}:passed`) : null,
        childRunRelPath,
        ...(runEvalReport !== undefined ? { runEvalReport } : {}),
      });

      if (options.onAfterChildEvaluation !== undefined) {
        await options.onAfterChildEvaluation(proposal, evalResult);
      }

      return evalResult;
    } finally {
      for (const item of restoredEnvKeys) {
        if (item.previous === undefined) {
          delete process.env[item.key];
        } else {
          process.env[item.key] = item.previous;
        }
      }
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

interface InternalDriverOptions {
  readonly store: EvolutionCampaignStore;
  readonly lease: CampaignLease;
  readonly campaignId: string;
  readonly manifest: EvolutionCampaignManifest;
  readonly taskpack: TaskpackManifest;
  readonly baseTaskContract: TaskContract;
  readonly modelIds: readonly string[];
  readonly repositoryRoot?: string | undefined;
  readonly evaluator: CandidateEvaluator;
  readonly proposeCandidateSlice?: ((context: CandidateProposalContext) => Promise<string>) | undefined;
  readonly supervisorRunner?: SupervisorRunnerPort | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly autoExport: boolean;
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
  const allStagePassed = (await store.listIndividuals(campaignId, { status: ['passed'], bucketId })).filter(ind =>
    objectives.every(obj => typeof ind.metrics[obj.metric] === 'number' && Number.isFinite(ind.metrics[obj.metric])),
  );
  if (allStagePassed.length === 0) return [];

  const stats = computeObjectiveReferenceStats(
    allStagePassed.map(ind => ind.metrics),
    objectives,
  );
  const ranked = computeNsga2Ranking(
    allStagePassed.map(ind => ({ individualId: ind.individualId, metrics: ind.metrics })),
    objectives,
  );
  const rankMap = new Map(ranked.map(r => [r.individualId, r] as const));

  await store.updateParetoRanks(
    lease,
    campaignId,
    allStagePassed.map(ind => {
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

  return store.listIndividuals(campaignId, { status: ['passed'], bucketId });
}

async function driveCampaignExecution(opts: InternalDriverOptions): Promise<RunEvolutionCampaignResult> {
  const { store, lease, campaignId, manifest, taskpack, baseTaskContract, modelIds, evaluator, scrubber } = opts;
  const budgets = manifest.spec.budgets;
  const population = manifest.spec.population;
  const sampling = manifest.spec.sampling;
  const objectives = manifest.spec.objectives;

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
        currentGeneration: gen,
      });

      const stagePassingBefore = await store.listIndividuals(campaignId, {
        status: ['passed'],
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
      const archiveHistorySlices: DecisionMutationNoveltyHistoryEntry[] = [];
      for (const prior of allPriorStageInds) {
        if ((prior.status !== 'passed' && prior.status !== 'soft_passed') || prior.codeSliceCasDigest === null) continue;
        const rawSlice = await store.readCasBlob(prior.codeSliceCasDigest.hex).catch(() => null);
        if (rawSlice !== null) {
          archiveHistorySlices.push({
            id: prior.individualId,
            sourceSlice: rawSlice.toString('utf8'),
          });
        }
      }

      const latestScratchpadRec = await store.getLatestScratchpadSnapshot(campaignId);
      const latestScratchpadMd = latestScratchpadRec !== null
        ? (await store.readCasBlob(latestScratchpadRec.casDigest.hex)).toString('utf8')
        : undefined;

      const remainingEvals = Math.min(
        budgets.maxEvaluations - currentCamp.evaluationsUsed,
        params.maxEvalsCeiling - currentCamp.evaluationsUsed,
      );
      const activeIslandCount = Math.min(population.islands, remainingEvals);
      const islandsList = await store.listIslands(campaignId);

      const preGenNichesByIsland = new Map<number, ReadonlyMap<string, IndividualRecord>>();
      for (let isl = 0; isl < activeIslandCount; isl += 1) {
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

      for (let isl = 0; isl < activeIslandCount; isl += 1) {
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

          const rng = createSeededPrng(`${campaignId}:gen-${gen}:isl-${isl}:seq-${seqIdx}`);
          const mutationKind: IndividualMutationKind = localElites.length === 0
            ? 'full_rewrite'
            : selectMutationKindDeterministically(rng, sampling.mutationWeights, totalParentPool);

          let sampledParents: readonly SampledParentEntry[] = [];
          let primaryParent: IndividualRecord | null = null;
          let stagedParentFiles: readonly StagedParentContextFile[] = [];

          if (localElites.length > 0) {
            const selection = sampleParents({
              islandId: isl,
              localCandidates: localElites,
              inspirationCandidates: migratedInspirations,
              maxCrossoversPerPrompt: mutationKind === 'crossover' ? sampling.maxCrossoversPerPrompt : 0,
              noveltyDecayLambda: sampling.noveltyDecayLambda,
              seed: `${campaignId}:parents:g${gen}:i${isl}`,
            });
            primaryParent = selection.primary.individual;
            sampledParents = [selection.primary, ...selection.secondary];

            const parentInputs: ParentContextInput[] = [];
            for (const sp of sampledParents) {
              const codeBytes = sp.individual.codeSliceCasDigest !== null
                ? await store.readCasBlob(sp.individual.codeSliceCasDigest.hex)
                : Buffer.from('// baseline\n', 'utf8');
              parentInputs.push({
                individual: sp.individual,
                role: sp.role,
                codeSlice: codeBytes.toString('utf8'),
              });
              await store.incrementOffspringCount(lease, sp.individual.individualId, 1);
            }

            const staged = await stageMultiParentContextFiles({
              stagingDir: join(childRunDir, 'parent-context'),
              parents: parentInputs,
              maxCrossoversPerPrompt: sampling.maxCrossoversPerPrompt,
              scrubber,
            });
            stagedParentFiles = staged.files;
          }

          // System-One advisory DSL track routing (verificationCertified: false)
          const parentDiag = primaryParent?.hardwareDiagnostics;
          const decisionDiag: DecisionHardwareDiagnostics | undefined = parentDiag?.boundPipeline !== undefined
            ? {
              boundPipeline: parentDiag.boundPipeline as DecisionHardwareDiagnostics['boundPipeline'],
              ...(parentDiag.rooflineHeadroom !== undefined ? { rooflineHeadroom: parentDiag.rooflineHeadroom } : {}),
              ...(parentDiag.occupancyPct !== undefined ? { occupancyPct: parentDiag.occupancyPct } : {}),
              ...(parentDiag.localSpillBytes !== undefined ? { localSpillBytes: parentDiag.localSpillBytes } : {}),
            }
            : undefined;

          const strategyDecision = await routeEvolutionStrategy({
            policy: DEFAULT_DECISION_POLICY,
            state: {},
            budget: decisionBudget,
            scrubber,
            strategy: {
              operatorKind: taskpack.metadata.name,
              tensorRank: 4,
              dtype: 'fp16',
              declaredTracks: AVAILABLE_EVOLUTION_TRACKS,
              allowedMutationKinds: ['diff_tune', 'full_rewrite', 'crossover'],
              stalledGenerations: islandRec.consecutiveNoGainGenerations,
              ...(decisionDiag !== undefined ? { hardwareDiagnostics: decisionDiag } : {}),
            },
          });
          advisoryDecisions.push(strategyDecision);
          const trackId = strategyDecision.trackId;

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

          const activeTeamRec = await store.getTeamConfig(islandRec.activeTeamConfigId);
          let activeTeamPatch: TeamPatchV1 | undefined;
          if (activeTeamRec?.patchCasDigest !== null && activeTeamRec?.patchCasDigest !== undefined) {
            const rawPatchBytes = await store.readCasBlob(activeTeamRec.patchCasDigest.hex);
            activeTeamPatch = parseTeamPatchV1(rawPatchBytes, { scrubber });
          }

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
            const noveltyDecision = await evaluateMutationNovelty({
              policy: DEFAULT_DECISION_POLICY,
              state: {},
              budget: decisionBudget,
              scrubber,
              novelty: {
                candidateId: individualId,
                candidateSlice: proposedCodeSlice,
                historySlices: archiveHistorySlices,
              },
            });
            advisoryDecisions.push(noveltyDecision);

            if (noveltyDecision.action === 'reject_resample') {
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
            ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          });

          let finalStatus = evalOutcome.status;
          let finalFailureReason = evalOutcome.failureReason ?? null;
          if (finalStatus === 'passed' && evalOutcome.smokeMetrics !== undefined) {
            const primaryMetric = objectives[0]?.metric ?? 'latency_us_p50';
            if (Object.hasOwn(evalOutcome.smokeMetrics, primaryMetric)) {
              const remainingRatio = Math.max(
                0,
                Math.min(1, (budgets.maxEvaluations - currentCampaignRow.evaluationsUsed) / budgets.maxEvaluations),
              );
              const cascadeDecision = await evaluateCascadeEscalation({
                policy: DEFAULT_DECISION_POLICY,
                state: {},
                budget: decisionBudget,
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

          const nicheKey = finalStatus === 'passed'
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
            paretoRank: finalStatus === 'passed' ? 1 : null,
            crowdingDistance: finalStatus === 'passed' ? 0 : null,
            scalarFitness: finalStatus === 'passed' ? 0.5 : null,
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
            const islandInds = await store.listIndividuals(campaignId, { islandId: isl });
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

      if (opts.signal?.aborted) {
        await store.updateCampaignProgress(lease, { campaignId, status: 'paused' });
        return 'paused';
      }
    }

    return 'completed_stage';
  };

  const currentCampaign = (await store.getCampaign(campaignId))!;
  if (manifest.spec.stages.mode === 'single-target') {
    const startGen = Math.max(1, currentCampaign.currentGeneration + (currentCampaign.evaluationsUsed > 0 ? 1 : 0));
    const outcome = await runStageGenerations({
      stagePhase: 'single-target',
      bucketId: null,
      heldOutWorkloadId: defaultHeldOutWorkloadId,
      startGen: Math.min(startGen, budgets.maxGenerations),
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

    let globalGenCursor = Math.max(1, currentCampaign.currentGeneration);

    if (currentCampaign.stagePhase !== 'portfolio') {
      const startBucketIdx = currentCampaign.activeBucketId !== null
        ? Math.max(0, specBuckets.findIndex(b => b.id === currentCampaign.activeBucketId))
        : 0;

      for (let bIdx = startBucketIdx; bIdx < specBuckets.length; bIdx += 1) {
        const bucket = specBuckets[bIdx]!;
        const freshCamp = (await store.getCampaign(campaignId))!;
        const remainingBucketsAfter = specBuckets.length - 1 - bIdx;
        const maxEvalsForThisBucket = Math.max(
          freshCamp.evaluationsUsed + 1,
          budgets.maxEvaluations - remainingBucketsAfter - 1,
        );
        const endGen = Math.min(budgets.maxGenerations - 1, globalGenCursor + gensPerBucket - 1);

        const stageRes = await runStageGenerations({
          stagePhase: 'specialist',
          bucketId: bucket.id,
          heldOutWorkloadId: bucket.heldOutWorkloadId,
          startGen: globalGenCursor,
          maxGenInclusive: Math.max(globalGenCursor, endGen),
          maxEvalsCeiling: maxEvalsForThisBucket,
        });
        globalGenCursor = Math.max(globalGenCursor + 1, endGen + 1);
        if (stageRes === 'paused') {
          break;
        }
      }
    }

    const afterSpecCamp = (await store.getCampaign(campaignId))!;
    if (afterSpecCamp.status !== 'paused' && !opts.signal?.aborted) {
      const winningSpecialists: IndividualRecord[] = [];
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
        winningSpecialists.push(sorted[0]!);
      }

      if (missingBucketWinner || afterSpecCamp.evaluationsUsed >= budgets.maxEvaluations) {
        await store.updateCampaignProgress(lease, { campaignId, status: 'failed' });
      } else {
        const portfolioGen = Math.min(budgets.maxGenerations, Math.max(globalGenCursor, afterSpecCamp.currentGeneration + 1));
        await store.updateCampaignProgress(lease, {
          campaignId,
          status: 'active',
          stagePhase: 'portfolio',
          activeBucketId: portfolioWorkloadId,
          currentGeneration: portfolioGen,
        });

        const islandsList = await store.listIslands(campaignId);
        const isl0 = islandsList[0]!;
        const portfolioId = sanitizeRunId(`ind-portfolio-g${portfolioGen}-${randomBytes(3).toString('hex')}`);
        const childRunDir = join(store.campaignRoot, 'runs', portfolioId);
        await mkdir(childRunDir, { recursive: true, mode: 0o700 });

        const parentInputs: ParentContextInput[] = [];
        const sampledPortfolioMembers: SampledParentEntry[] = [];
        for (let idx = 0; idx < winningSpecialists.length; idx += 1) {
          const specWinner = winningSpecialists[idx]!;
          const codeBytes = specWinner.codeSliceCasDigest !== null
            ? await store.readCasBlob(specWinner.codeSliceCasDigest.hex)
            : Buffer.from('// specialist\n', 'utf8');
          const contextRole = idx === 0 ? ('primary' as const) : ('crossover_donor' as const);
          parentInputs.push({
            individual: specWinner,
            role: contextRole,
            codeSlice: codeBytes.toString('utf8'),
          });
          sampledPortfolioMembers.push({
            individual: specWinner,
            role: contextRole,
            sourceIslandId: specWinner.islandId,
            weight: 1,
          });
        }

        const stagedPortfolioCtx = await stageMultiParentContextFiles({
          stagingDir: join(childRunDir, 'portfolio-specialists'),
          parents: parentInputs,
          maxCrossoversPerPrompt: Math.max(1, winningSpecialists.length),
          scrubber,
        });

        const arms = await store.listModelBanditArms(campaignId);
        const modelPick = selectModelCandidate({
          strategy: sampling.modelBandit,
          modelIds,
          arms,
          sequenceIndex: sequenceCounter,
        });

        const portfolioTrackId = winningSpecialists[0]?.trackId ?? 'cuda_raw';
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
          portfolioSpecialists: winningSpecialists,
          campaignRoot: store.campaignRoot,
          childRunDir,
          baseRevision: afterSpecCamp.baseRevision,
          manifest,
          taskpack,
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
            parentIndividualId: sw.individualId,
            role: 'portfolio_member' as const,
            sourceIslandId: sw.islandId,
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
    exportedBundle = await exportEvolutionBundle({
      store,
      campaignId,
      outputDir: resolvedOutDir,
      format: manifest.spec.export.format,
      allowSyntheticProbe: opts.allowSyntheticProbe,
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
  const checked = await checkEvolutionCampaign({
    ...(options.manifestPath !== undefined ? { manifestPath: options.manifestPath } : {}),
    ...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
    ...(options.format !== undefined ? { format: options.format } : {}),
    ...(options.repositoryRoot !== undefined ? { repositoryRoot: options.repositoryRoot } : {}),
    ...(options.taskpack !== undefined ? { taskpack: options.taskpack } : {}),
    scrubber,
  });

  const evaluator = resolveCampaignEvaluator(options.evaluator, options.controllerEvaluatorOptions);
  const campaignId = options.campaignId ?? `camp-${checked.manifest.metadata.name}-${randomBytes(4).toString('hex')}`;
  const baseRevision = options.baseRevision ?? resolveGitHeadRevision(options.repositoryRoot);
  const { lockHash, baseTaskContract } = await computeBaselineCampaignLockHash(
    checked.taskpack,
    campaignId,
    baseRevision,
    options.repositoryRoot,
  );

  const store = await EvolutionCampaignStore.open({
    campaignRoot: options.campaignRoot,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    createIfMissing: true,
  });

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
    stagePhase: initialStagePhase,
    activeBucketId: initialBucketId,
    modelIds: checked.modelIds,
  });

  await store.ensureModelBanditArms(lease, campaignId, checked.modelIds);

  return driveCampaignExecution({
    store,
    lease,
    campaignId,
    manifest: checked.manifest,
    taskpack: checked.taskpack,
    baseTaskContract,
    modelIds: checked.modelIds,
    ...(options.repositoryRoot !== undefined ? { repositoryRoot: options.repositoryRoot } : {}),
    evaluator,
    ...(options.proposeCandidateSlice !== undefined ? { proposeCandidateSlice: options.proposeCandidateSlice } : {}),
    ...(options.supervisorRunner !== undefined ? { supervisorRunner: options.supervisorRunner } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    autoExport: options.autoExport ?? true,
    allowSyntheticProbe: options.allowSyntheticProbe === true,
    ...(options.receiptSigningSecret !== undefined ? { receiptSigningSecret: options.receiptSigningSecret } : {}),
    ...(options.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: options.verifyReceiptSignature } : {}),
    ...(options.dispatchManifest !== undefined ? { dispatchManifest: options.dispatchManifest } : {}),
    scrubber,
  });
}

/**
 * Resume an existing paused or interrupted campaign from `<campaignRoot>/campaign.sqlite`
 * under a newly fenced coordinator lease without double-counting `maxEvaluations` or `trial_used_generations`.
 */
export async function resumeEvolutionCampaign(
  options: ResumeEvolutionCampaignOptions,
): Promise<RunEvolutionCampaignResult> {
  const scrubber = options.scrubber ?? DEFAULT_CAMPAIGN_SCRUBBER;
  const evaluator = resolveCampaignEvaluator(options.evaluator, options.controllerEvaluatorOptions);

  const store = await EvolutionCampaignStore.open({
    campaignRoot: options.campaignRoot,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    createIfMissing: false,
  });

  const lease = await store.acquireLease(`resume-coordinator-${randomBytes(6).toString('hex')}`);

  let existingCampaign: CampaignRecord | null;
  if (options.campaignId !== undefined) {
    existingCampaign = await store.getCampaign(options.campaignId);
  } else {
    const all = await store.listCampaigns();
    existingCampaign = all[0] ?? null;
  }
  if (existingCampaign === null) {
    await store.close();
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
    ...(options.repositoryRoot !== undefined ? { repositoryRoot: options.repositoryRoot } : {}),
    ...(options.taskpack !== undefined ? { taskpack: options.taskpack } : {}),
    scrubber,
  });

  const { baseTaskContract } = await computeBaselineCampaignLockHash(
    checked.taskpack,
    existingCampaign.campaignId,
    existingCampaign.baseRevision,
    options.repositoryRoot,
  );

  await store.ensureModelBanditArms(lease, existingCampaign.campaignId, checked.modelIds);
  await store.updateCampaignProgress(lease, {
    campaignId: existingCampaign.campaignId,
    status: 'active',
  });

  return driveCampaignExecution({
    store,
    lease,
    campaignId: existingCampaign.campaignId,
    manifest: existingCampaign.manifest,
    taskpack: checked.taskpack,
    baseTaskContract,
    modelIds: checked.modelIds,
    ...(options.repositoryRoot !== undefined ? { repositoryRoot: options.repositoryRoot } : {}),
    evaluator,
    ...(options.proposeCandidateSlice !== undefined ? { proposeCandidateSlice: options.proposeCandidateSlice } : {}),
    ...(options.supervisorRunner !== undefined ? { supervisorRunner: options.supervisorRunner } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    autoExport: options.autoExport ?? true,
    allowSyntheticProbe: options.allowSyntheticProbe === true,
    ...(options.receiptSigningSecret !== undefined ? { receiptSigningSecret: options.receiptSigningSecret } : {}),
    ...(options.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: options.verifyReceiptSignature } : {}),
    ...(options.dispatchManifest !== undefined ? { dispatchManifest: options.dispatchManifest } : {}),
    scrubber,
  });
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
