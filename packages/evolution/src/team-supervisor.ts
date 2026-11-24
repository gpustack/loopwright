import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  LIMITS,
  SecretScrubber,
  validateDocument,
  type Digest,
  type StepHandoffSelector,
  type TaskContract,
} from '@loopwright/core';
import {
  CONTROLLER_API_VERSION,
  installedHandlerDigests,
  loadTrustedConfiguration,
  stepCancel,
  stepNext,
  stepSubmit,
  type CheckpointCapacity,
  type ControllerPolicyProfile,
  type RunEvalReport,
  type TrustedRegistry,
} from '@loopwright/controller';
import type { TaskpackManifest, TaskpackToolName } from '@loopwright/taskpack';
import {
  canonicalizeJson,
  parseNullProtoJson,
  parseTeamPatchV1,
  type NullProtoJson,
} from './schema.js';
import type { EvolutionCampaignStore } from './store.js';
import {
  EvolutionError,
  TEAM_PATCH_MAX_BYTES,
  type CampaignLease,
  type EvolutionBudgetsSpec,
  type EvolutionTeamSpec,
  type IndividualRecord,
  type IslandRecord,
  type TeamConfigRecord,
  type TeamConfigStatus,
  type TeamPatchV1,
} from './types.js';

const DEFAULT_SUPERVISOR_SCRUBBER = new SecretScrubber();
const MAX_STAGED_DIAGNOSTIC_BYTES = 262_144;
const MUTATING_OR_EXEC_TOOLS: ReadonlySet<string> = new Set(['write', 'edit', 'delete', 'bash']);

const FORBIDDEN_PATCH_AUTHORITY_KEYS: ReadonlySet<string> = new Set([
  'scope',
  'writable',
  'protected',
  'acceptance',
  'checks',
  'evolveBlocks',
  'trustedContext',
  'discovery',
  'network',
  'mounts',
  'mcp',
  'mcpServers',
  'credentials',
  'capabilities',
  'allowWorkflowWrites',
  'heldOutWorkloadId',
]);

export type TeamTriggerReason = 'pareto_stagnation' | 'run_eval_pathology';

export type TeamTriggerSuppressedReason =
  | 'disabled'
  | 'trial_in_progress'
  | 'insufficient_evaluation_budget'
  | 'insufficient_generation_budget'
  | 'target_roofline_reached'
  | 'steady_progress';

export interface EvaluateTeamTriggerInput {
  readonly teamEvolution?: EvolutionTeamSpec | undefined;
  readonly island: IslandRecord;
  readonly budgets: EvolutionBudgetsSpec;
  readonly evaluationsUsed: number;
  readonly currentGeneration: number;
  readonly recentRunEvals?: readonly RunEvalReport[] | undefined;
  readonly activeTeamStatus?: TeamConfigStatus | undefined;
}

export interface TeamEvolutionTriggerDecision {
  readonly shouldInvoke: boolean;
  readonly triggerReason?: TeamTriggerReason;
  readonly suppressedReason?: TeamTriggerSuppressedReason;
  readonly consecutiveNoGainGenerations: number;
  readonly consecutivePathologyRuns: number;
}

export interface IslandTrajectoryEntry {
  readonly generation: number;
  readonly hypervolume: number;
  readonly bestScalarFitness: number | null;
  readonly nichesOpen: number;
}

export interface StagedSupervisorFile {
  readonly name: string;
  readonly filePath: string;
  readonly resourceId: string;
  readonly relativeResourcePath: string;
  readonly digest: Digest;
  readonly byteLength: number;
}

export type PinnedContextResource = TaskContract['spec']['trustedContext']['resources'][number];

export interface StageSupervisorContextInput {
  readonly stagingDir: string;
  readonly campaignId: string;
  readonly island: IslandRecord;
  readonly triggerReason: TeamTriggerReason;
  readonly teamEvolution: EvolutionTeamSpec;
  readonly baseTaskContract: TaskContract;
  readonly trajectory?: readonly IslandTrajectoryEntry[] | undefined;
  readonly recentRunEvals?: readonly RunEvalReport[] | undefined;
  readonly recentIndividuals?: readonly IndividualRecord[] | undefined;
  readonly latestScratchpadMarkdown?: string | undefined;
  readonly teamHistory?: readonly TeamConfigRecord[] | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface StagedSupervisorContext {
  readonly stagingDir: string;
  readonly files: readonly StagedSupervisorFile[];
  readonly supervisorContract: TaskContract;
  readonly writablePaths: readonly [];
  readonly prompt: string;
}

export interface ArchetypeRoleEnvelope {
  readonly id: string;
  readonly adapter: 'pi' | 'delegated';
  readonly purpose: 'task' | 'review';
  readonly tools: readonly TaskpackToolName[];
  readonly maxTimeoutSeconds: number;
  readonly defaultModel?: string | undefined;
  readonly provider?: string | undefined;
  readonly thinking?: string | undefined;
}

export interface ComputePatchCheckpointCapacityInput {
  readonly maxAttempts: number;
  readonly agentStepsCount: number;
  readonly maxImplementationRepairs: number;
  readonly verifierSlotCount: number;
  readonly publicationEnabled?: boolean | undefined;
  readonly reworkGenerations?: number | undefined;
  readonly checkReworkGenerations?: number | undefined;
}

export interface ValidateAndCompileTeamPatchInput {
  readonly rawPatch: unknown;
  readonly teamEvolution: EvolutionTeamSpec;
  readonly baseTaskContract: TaskContract;
  readonly taskpack?: TaskpackManifest | undefined;
  readonly trustedRegistry?: TrustedRegistry | undefined;
  readonly archetypes?: readonly ArchetypeRoleEnvelope[] | undefined;
  readonly extraPinnedResources?: readonly PinnedContextResource[] | undefined;
  readonly maxAttempts?: number | undefined;
  readonly publicationEnabled?: boolean | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface CompiledRoleModelBinding {
  readonly provider: string;
  readonly model: string;
  readonly thinking: string;
  readonly timeoutSeconds?: number;
}

export interface CompiledTeamPatchResult {
  readonly patch: TeamPatchV1;
  readonly canonicalPatchJson: string;
  readonly patchDigest: Digest;
  readonly taskContract: TaskContract;
  readonly capacity: CheckpointCapacity;
  readonly resolvedRoleModels: Readonly<Record<string, CompiledRoleModelBinding>>;
  readonly compiledRegistry?: TrustedRegistry;
}

export interface RecordTeamTrialOutcomeInput {
  readonly campaignId: string;
  readonly islandId: number;
  readonly teamConfigId: string;
  readonly advancedPareto: boolean;
  readonly discoveredNiche: boolean;
  readonly preempted?: boolean | undefined;
}

export interface TeamTrialOutcomeResult {
  readonly teamConfig: TeamConfigRecord;
  readonly previousStatus: TeamConfigStatus;
  readonly nextStatus: TeamConfigStatus;
  readonly activeTeamConfigId: string;
  readonly promoted: boolean;
  readonly rolledBack: boolean;
  readonly ignoredPreemption: boolean;
}

export interface SupervisorExecutionContext {
  readonly campaignId: string;
  readonly island: IslandRecord;
  readonly triggerReason: TeamTriggerReason;
  readonly stagingDir: string;
  readonly files: readonly StagedSupervisorFile[];
  readonly supervisorContract: TaskContract;
  readonly writablePaths: readonly [];
  readonly prompt: string;
}

export type SupervisorRunnerPort = (
  context: SupervisorExecutionContext,
) => Promise<string | Uint8Array | Record<string, unknown>>;

export interface ReadOnlySupervisorTurnContext extends SupervisorExecutionContext {
  readonly runRoot: string;
  readonly runId: string;
  readonly stepId: string;
  readonly roleId: string;
  readonly candidateDir: string;
  readonly contextFiles: readonly string[];
  readonly leaseToken: string;
  readonly tools: readonly ['read'];
  readonly signal?: AbortSignal | undefined;
}

export interface LocalRunStoreSupervisorRunnerOptions {
  readonly executeReadOnlySupervisorTurn: (
    turn: ReadOnlySupervisorTurnContext,
  ) => Promise<string | Uint8Array | Record<string, unknown>>;
  readonly environment?: ((name: string) => string | undefined) | undefined;
  readonly policyProfile?: ControllerPolicyProfile | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface RunPlateauSupervisorTurnInput {
  readonly store: EvolutionCampaignStore;
  readonly lease: CampaignLease;
  readonly campaignId: string;
  readonly island: IslandRecord;
  readonly teamEvolution?: EvolutionTeamSpec | undefined;
  readonly budgets: EvolutionBudgetsSpec;
  readonly evaluationsUsed: number;
  readonly currentGeneration: number;
  readonly baseTaskContract: TaskContract;
  readonly taskpack?: TaskpackManifest | undefined;
  readonly trustedRegistry?: TrustedRegistry | undefined;
  readonly archetypes?: readonly ArchetypeRoleEnvelope[] | undefined;
  readonly extraPinnedResources?: readonly PinnedContextResource[] | undefined;
  readonly trajectory?: readonly IslandTrajectoryEntry[] | undefined;
  readonly recentRunEvals?: readonly RunEvalReport[] | undefined;
  readonly recentIndividuals?: readonly IndividualRecord[] | undefined;
  readonly latestScratchpadMarkdown?: string | undefined;
  readonly stagingDir: string;
  readonly supervisorRunner: SupervisorRunnerPort;
  readonly scrubber?: SecretScrubber | undefined;
}

export interface PlateauSupervisorTurnResult {
  readonly invoked: boolean;
  readonly accepted: boolean;
  readonly decision: TeamEvolutionTriggerDecision;
  readonly activeTeamConfigId: string;
  readonly teamConfig?: TeamConfigRecord;
  readonly compiledPatch?: CompiledTeamPatchResult;
  readonly stagedContext?: StagedSupervisorContext;
  readonly error?: EvolutionError;
}

function sha256Digest(bytes: Uint8Array | string): Digest {
  return Object.freeze({
    algorithm: 'sha256' as const,
    hex: createHash('sha256').update(bytes).digest('hex'),
  });
}

function assertCleanSecrets(text: string, scrubber: SecretScrubber, diagPath: string): void {
  const scrubbed = scrubber.scrub(text);
  if (scrubbed !== text) {
    throw new EvolutionError(
      'SECRET_LEAK_DETECTED',
      `secret pattern detected while staging or validating ${diagPath}`,
      diagPath,
    );
  }
}

function sanitizeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, LIMITS.identifier);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Detect whether a single child `RunEvalReport` exhibits loop pathology (`pingPong` cycles or
 * `toolRepeats` circuit-breaker trips `consecutive_tool_errors` / `no_progress`).
 */
export function hasRunEvalLoopPathology(report: RunEvalReport): boolean {
  if (report.pingPong.detected === true) {
    return true;
  }
  const cb = report.toolRepeats.circuitBreaker;
  return cb === 'consecutive_tool_errors' || cb === 'no_progress';
}

function countTrailingPathologyRuns(reports: readonly RunEvalReport[] | undefined): number {
  if (reports === undefined || reports.length === 0) return 0;
  let count = 0;
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    if (hasRunEvalLoopPathology(reports[i]!)) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Pure event-driven plateau / pathology trigger check with zero steady-state overhead.
 */
export function evaluateTeamEvolutionTrigger(input: EvaluateTeamTriggerInput): TeamEvolutionTriggerDecision {
  const { teamEvolution, island, budgets, evaluationsUsed, currentGeneration } = input;
  const trailingFromReports = countTrailingPathologyRuns(input.recentRunEvals);
  const consecutivePathologyRuns = Math.max(island.consecutivePathologyRuns, trailingFromReports);
  const consecutiveNoGainGenerations = island.consecutiveNoGainGenerations;

  if (teamEvolution?.enabled !== true) {
    return Object.freeze({
      shouldInvoke: false,
      suppressedReason: 'disabled',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  if (input.activeTeamStatus === 'trial') {
    return Object.freeze({
      shouldInvoke: false,
      suppressedReason: 'trial_in_progress',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  // Must cover at least 1 supervisor turn + 1 child evaluation
  if (budgets.maxEvaluations - evaluationsUsed < 2) {
    return Object.freeze({
      shouldInvoke: false,
      suppressedReason: 'insufficient_evaluation_budget',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  if (budgets.maxGenerations - currentGeneration < 1) {
    return Object.freeze({
      shouldInvoke: false,
      suppressedReason: 'insufficient_generation_budget',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  if (
    budgets.targetRooflineHeadroom !== undefined
    && island.bestRooflineHeadroom !== null
    && island.bestRooflineHeadroom <= budgets.targetRooflineHeadroom
  ) {
    return Object.freeze({
      shouldInvoke: false,
      suppressedReason: 'target_roofline_reached',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  if (teamEvolution.triggerOnRunEvalPathology && consecutivePathologyRuns >= 2) {
    return Object.freeze({
      shouldInvoke: true,
      triggerReason: 'run_eval_pathology',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  if (consecutiveNoGainGenerations >= teamEvolution.stallGenerations) {
    return Object.freeze({
      shouldInvoke: true,
      triggerReason: 'pareto_stagnation',
      consecutiveNoGainGenerations,
      consecutivePathologyRuns,
    });
  }

  return Object.freeze({
    shouldInvoke: false,
    suppressedReason: 'steady_progress',
    consecutiveNoGainGenerations,
    consecutivePathologyRuns,
  });
}

async function ensurePrivateNonSymlinkDir(dirPath: string): Promise<string> {
  if (!isAbsolute(dirPath) || dirPath.includes('\0')) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `stagingDir must be an absolute path: "${dirPath}"`);
  }
  const resolved = resolve(dirPath);
  const existing = await lstat(resolved).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (existing !== null && existing.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink staging directory forbidden: "${resolved}"`);
  }

  const parent = dirname(resolved);
  const parentStat = await lstat(parent).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (parentStat !== null && parentStat.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink parent directory forbidden: "${parent}"`);
  }

  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const afterStat = await lstat(resolved);
  if (afterStat.isSymbolicLink() || !afterStat.isDirectory()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `staging directory must be a real directory: "${resolved}"`);
  }
  await chmod(resolved, 0o700);
  const dirHandle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  await dirHandle.close();
  await realpath(resolved);
  return resolved;
}

async function writeReadOnlyFileNoFollow(
  dirPath: string,
  fileName: string,
  content: string,
  scrubber: SecretScrubber,
): Promise<{ readonly filePath: string; readonly digest: Digest; readonly byteLength: number }> {
  const diagPath = `${dirPath}/${fileName}`;
  assertCleanSecrets(content, scrubber, diagPath);
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_STAGED_DIAGNOSTIC_BYTES) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      `staged supervisor artifact "${fileName}" exceeds ${MAX_STAGED_DIAGNOSTIC_BYTES} bytes`,
      diagPath,
    );
  }
  const targetPath = join(dirPath, fileName);
  const existing = await lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink staged file forbidden: "${targetPath}"`);
    }
    await chmod(targetPath, 0o600).catch(() => undefined);
    await unlink(targetPath);
  }

  const tmpPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(
    tmpPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await fh.writeFile(bytes);
    await fh.chmod(0o400);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, targetPath);

  const verifyFh = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await verifyFh.stat();
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o777) !== 0o400) {
      throw new EvolutionError('ARTIFACT_INVALID', `staged supervisor file failed 0o400 regular-file check: "${targetPath}"`);
    }
  } finally {
    await verifyFh.close();
  }

  return Object.freeze({
    filePath: targetPath,
    digest: sha256Digest(bytes),
    byteLength: bytes.byteLength,
  });
}

/**
 * Stage read-only (`0o400`, `O_NOFOLLOW`, `SecretScrubber`-verified) diagnostic context artifacts
 * and synthesize a strictly read-only (`tools: ['read']`, zero writable files, zero `held_out_workloads`)
 * supervisor `TaskContract`.
 */
export async function stageSupervisorContext(input: StageSupervisorContextInput): Promise<StagedSupervisorContext> {
  const scrubber = input.scrubber ?? DEFAULT_SUPERVISOR_SCRUBBER;
  const resolvedDir = await ensurePrivateNonSymlinkDir(input.stagingDir);

  const trajectoryJson = canonicalizeJson({
    campaignId: input.campaignId,
    islandId: input.island.islandId,
    currentGeneration: input.island.currentGeneration,
    consecutiveNoGainGenerations: input.island.consecutiveNoGainGenerations,
    consecutivePathologyRuns: input.island.consecutivePathologyRuns,
    lastHypervolume: input.island.lastHypervolume,
    bestRooflineHeadroom: input.island.bestRooflineHeadroom,
    triggerReason: input.triggerReason,
    trajectory: (input.trajectory ?? []).slice(-32),
  });

  const runEvalSummariesJson = canonicalizeJson(
    (input.recentRunEvals ?? []).slice(-8).map(rep => ({
      runId: rep.runId,
      status: rep.status,
      pingPong: rep.pingPong,
      toolRepeats: {
        totalFailingCalls: rep.toolRepeats.totalFailingCalls,
        circuitBreaker: rep.toolRepeats.circuitBreaker,
        items: rep.toolRepeats.items.slice(0, 8),
      },
      repairConvergence: rep.repairConvergence,
      suggestions: rep.suggestions.slice(0, 8),
    })),
  );

  const hardwareDiagJson = canonicalizeJson(
    (input.recentIndividuals ?? []).slice(-16).map(ind => ({
      individualId: ind.individualId,
      generation: ind.generation,
      status: ind.status,
      failureReason: ind.failureReason,
      nicheKey: ind.nicheKey,
      paretoRank: ind.paretoRank,
      scalarFitness: ind.scalarFitness,
      metrics: ind.metrics,
      ...(ind.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: ind.hardwareDiagnostics } : {}),
      ...(ind.findings !== undefined ? { findings: ind.findings.slice(0, 8) } : {}),
    })),
  );

  const teamHistoryJson = canonicalizeJson(
    (input.teamHistory ?? []).slice(-16).map(tc => ({
      teamConfigId: tc.teamConfigId,
      parentTeamConfigId: tc.parentTeamConfigId,
      status: tc.status,
      createdGeneration: tc.createdGeneration,
      trialBudgetGenerations: tc.trialBudgetGenerations,
      trialUsedGenerations: tc.trialUsedGenerations,
      paretoAdvances: tc.paretoAdvances,
      nicheDiscoveries: tc.nicheDiscoveries,
      diagnosis: tc.diagnosis,
      patchCasDigest: tc.patchCasDigest,
    })),
  );

  const scratchpadText = input.latestScratchpadMarkdown !== undefined && input.latestScratchpadMarkdown.trim().length > 0
    ? input.latestScratchpadMarkdown
    : '# Campaign Scratchpad\nNo prior scratchpad entries recorded.\n';

  const artifactEntries: readonly {
    readonly name: string;
    readonly resourceId: string;
    readonly content: string;
  }[] = [
    { name: 'island-trajectory.json', resourceId: 'sup-island-trajectory', content: `${trajectoryJson}\n` },
    { name: 'run-eval-summaries.json', resourceId: 'sup-run-eval-summaries', content: `${runEvalSummariesJson}\n` },
    { name: 'hardware-diagnostics.json', resourceId: 'sup-hardware-diagnostics', content: `${hardwareDiagJson}\n` },
    { name: 'team-history.json', resourceId: 'sup-team-history', content: `${teamHistoryJson}\n` },
    { name: 'scratchpad.md', resourceId: 'sup-scratchpad', content: scratchpadText },
  ];

  const files: StagedSupervisorFile[] = [];
  const supervisorResources: PinnedContextResource[] = [];

  for (const item of artifactEntries) {
    const written = await writeReadOnlyFileNoFollow(resolvedDir, item.name, item.content, scrubber);
    const relativeResourcePath = `.loopwright/supervisor-context/${item.name}`;
    files.push(
      Object.freeze({
        name: item.name,
        filePath: written.filePath,
        resourceId: item.resourceId,
        relativeResourcePath,
        digest: written.digest,
        byteLength: written.byteLength,
      }),
    );
    supervisorResources.push({
      id: item.resourceId,
      kind: 'document',
      path: relativeResourcePath,
      digest: written.digest,
    });
  }

  const prompt = [
    `Diagnose island ${input.island.islandId} plateau (${input.triggerReason}) using ONLY read-only staged context.`,
    `Do NOT write candidate code or repeat previously rolled_back topologies listed in team-history.json.`,
    `Allowed archetype roles: ${input.teamEvolution.allowedArchetypeRoles.join(', ')}.`,
    `Emit ONLY one raw UTF-8 JSON object matching schemaVersion "team-patch.v1" (kind "TeamPatch").`,
  ].join(' ');
  assertCleanSecrets(prompt, scrubber, '/supervisorPrompt');

  // Protect '**' alongside base protected paths so every repository path is strictly non-writable (`isWritablePath === false`),
  // and bind ONLY local `supervisor-no-change` check with zero `hardware_execution` / `held_out_workloads` bindings.
  const protectedPatterns = Array.from(new Set(['**', ...input.baseTaskContract.spec.scope.protected]));
  const baseRole = input.baseTaskContract.spec.roles[0];
  const rawSupervisorContract = {
    apiVersion: 'loopwright.dev/v1alpha1' as const,
    kind: 'TaskContract' as const,
    spec: {
      goal: prompt,
      taskpack: sanitizeIdentifier(
        `supervisor-${input.campaignId}-isl-${input.island.islandId}`,
        input.baseTaskContract.spec.taskpack,
      ),
      target: {
        repository: input.baseTaskContract.spec.target.repository,
        baseRevision: input.baseTaskContract.spec.target.baseRevision,
        sourceRevision: input.baseTaskContract.spec.target.sourceRevision,
        matrix: null,
      },
      scope: {
        writable: [...input.baseTaskContract.spec.scope.writable],
        protected: protectedPatterns,
      },
      roles: [
        {
          id: input.teamEvolution.supervisorRoleId,
          adapter: 'delegated',
          provider: baseRole?.provider ?? 'delegated',
          model: baseRole?.model ?? 'default',
          thinking: baseRole?.thinking ?? 'medium',
          tools: ['read'],
          resourceIds: supervisorResources.map(r => r.id),
        },
      ],
      trustedContext: {
        revision: input.baseTaskContract.spec.trustedContext.revision,
        discovery: 'disabled' as const,
        resources: supervisorResources,
      },
      budgets: {
        ...input.baseTaskContract.spec.budgets,
        wallTimeMs: Math.max(10_000, Math.min(input.baseTaskContract.spec.budgets.wallTimeMs, 120_000)),
        totalTokens: Math.min(input.baseTaskContract.spec.budgets.totalTokens, 100_000),
        maxModelCalls: 4,
        maxConcurrency: 1,
        maxFormatRepairs: 0,
        maxImplementationRepairs: 0,
      },
      steps: [
        {
          id: 'step-supervisor',
          kind: 'agent' as const,
          uses: `handler.${input.teamEvolution.supervisorRoleId}`.slice(0, LIMITS.identifier),
          roleId: input.teamEvolution.supervisorRoleId,
          dependsOn: [],
        },
        {
          id: 'check-supervisor-readonly',
          kind: 'check' as const,
          uses: 'supervisor-no-change',
          roleId: null,
          dependsOn: ['step-supervisor'],
        },
      ],
      acceptance: {
        required: ['supervisor-no-change'],
        checks: [
          {
            id: 'supervisor-no-change',
            allowedEvidenceLevels: ['local_execution'],
          },
        ],
      },
    },
  };

  const validated = validateDocument(rawSupervisorContract, 'TaskContract');
  if (!validated.ok) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      `failed to construct read-only supervisor TaskContract: ${validated.errors[0]?.code ?? 'invalid'} at ${validated.errors[0]?.path ?? '/'}`,
    );
  }

  return Object.freeze({
    stagingDir: resolvedDir,
    files: Object.freeze(files),
    supervisorContract: validated.value,
    writablePaths: Object.freeze([] as const),
    prompt,
  });
}

/**
 * Exact controller checkpoint capacity precheck (`D <= 256`) matching `@loopwright/controller` `compile.ts`.
 */
export function computePatchCheckpointCapacity(input: ComputePatchCheckpointCapacityInput): CheckpointCapacity {
  const A = input.maxAttempts;
  const N = input.agentStepsCount;
  const I = input.maxImplementationRepairs;
  const C = input.verifierSlotCount;
  const R = input.reworkGenerations ?? 0;
  const K = input.checkReworkGenerations ?? 0;
  const publication = input.publicationEnabled === true;

  const V = 1 + Math.min(A + K, N + I + R);
  const J = C * V;
  const D = 4 + 3 * A + 2 * J + (publication ? 3 : 0);

  return Object.freeze({
    A,
    N,
    I,
    C,
    V,
    J,
    D,
    publication,
    additionalRefs: 4,
    requiredRefs: 6,
    checkpointBytes: 40_960,
  });
}

function inspectForbiddenAuthorityKeys(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      inspectForbiddenAuthorityKeys(value[i], `${path}/${i}`);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    // Allow `required` inside `/steps/<idx>/handoffs/<hIdx>/required`
    if (key === 'required' && path.includes('/handoffs/')) {
      continue;
    }
    if (FORBIDDEN_PATCH_AUTHORITY_KEYS.has(key)) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `supervisor patch attempted forbidden authority or scope override "${key}" at ${path || '/'}`,
        `${path}/${key}`,
      );
    }
    inspectForbiddenAuthorityKeys(obj[key], `${path}/${key}`);
  }
}

function resolveArchetypes(input: ValidateAndCompileTeamPatchInput): Map<string, ArchetypeRoleEnvelope> {
  const map = new Map<string, ArchetypeRoleEnvelope>();
  const registryProfiles = new Map<string, TrustedRegistry['spec']['roleProfiles'][number]>();
  if (input.trustedRegistry !== undefined) {
    for (const p of input.trustedRegistry.spec.roleProfiles) {
      registryProfiles.set(p.id, p);
      if (p.id.startsWith('role.')) {
        registryProfiles.set(p.id.slice(5), p);
      }
      if (p.id.startsWith('taskpack.profile.')) {
        registryProfiles.set(p.id.slice('taskpack.profile.'.length), p);
      }
      if (p.id === 'taskpack-author-role') {
        registryProfiles.set('author', p);
      }
    }
  }

  const defaultWallSec = Math.max(1, Math.floor(input.baseTaskContract.spec.budgets.wallTimeMs / 1000));

  if (input.archetypes !== undefined) {
    for (const arch of input.archetypes) {
      const regProf = registryProfiles.get(arch.id);
      const regMaxSec = regProf?.limits?.toolWallMs !== undefined
        ? Math.max(1, Math.floor(regProf.limits.toolWallMs / 1000))
        : arch.maxTimeoutSeconds;
      map.set(arch.id, {
        ...arch,
        maxTimeoutSeconds: Math.min(arch.maxTimeoutSeconds, regMaxSec),
      });
    }
  }

  if (input.taskpack !== undefined) {
    const firstModel = input.taskpack.spec.models?.[0];
    const taskpackToolSec = input.taskpack.spec.limits?.toolTimeoutSeconds;
    const effectiveDefaultWallSec = taskpackToolSec !== undefined
      ? Math.min(defaultWallSec, taskpackToolSec)
      : defaultWallSec;
    if (input.taskpack.spec.roles !== undefined && input.taskpack.spec.roles.length > 0) {
      for (const role of input.taskpack.spec.roles) {
        if (map.has(role.id)) continue;
        const regProf = input.trustedRegistry !== undefined ? registryProfiles.get(role.id) : undefined;
        if (input.trustedRegistry !== undefined && regProf === undefined) {
          continue;
        }
        const purpose = role.purpose ?? 'task';
        const defaultTools: readonly TaskpackToolName[] = purpose === 'review'
          ? ['read']
          : ['read', 'write', 'edit', 'bash'];
        const tools = regProf?.tools !== undefined
          ? (regProf.tools.filter(t => (role.tools ?? defaultTools).includes(t as TaskpackToolName)) as readonly TaskpackToolName[])
          : (role.tools ?? defaultTools);
        const regMaxSec = regProf?.limits?.toolWallMs !== undefined
          ? Math.max(1, Math.floor(regProf.limits.toolWallMs / 1000))
          : effectiveDefaultWallSec;
        map.set(role.id, {
          id: role.id,
          adapter: regProf?.adapter === 'pi' ? 'pi' : 'delegated',
          purpose,
          tools: tools.length > 0 ? tools : (role.tools ?? defaultTools),
          maxTimeoutSeconds: regMaxSec,
          provider: role.provider ?? firstModel?.provider ?? 'delegated',
          defaultModel: role.model ?? firstModel?.id ?? 'default',
          thinking: role.thinking ?? firstModel?.thinking ?? 'medium',
        });
      }
    } else if (!map.has('author')) {
      const regProf = input.trustedRegistry !== undefined ? registryProfiles.get('author') : undefined;
      if (input.trustedRegistry === undefined || regProf !== undefined) {
        const regMaxSec = regProf?.limits?.toolWallMs !== undefined
          ? Math.max(1, Math.floor(regProf.limits.toolWallMs / 1000))
          : effectiveDefaultWallSec;
        map.set('author', {
          id: 'author',
          adapter: 'delegated',
          purpose: 'task',
          tools: ['read', 'write', 'edit', 'bash', 'delete'],
          maxTimeoutSeconds: regMaxSec,
          provider: firstModel?.provider ?? 'delegated',
          defaultModel: firstModel?.id ?? 'default',
          thinking: firstModel?.thinking ?? 'medium',
        });
      }
    }
  }

  if (input.taskpack === undefined && input.archetypes === undefined) {
    for (const role of input.baseTaskContract.spec.roles) {
      const regProf = input.trustedRegistry !== undefined ? registryProfiles.get(role.id) : undefined;
      if (input.trustedRegistry !== undefined && regProf === undefined) continue;
      const regMaxSec = regProf?.limits?.toolWallMs !== undefined
        ? Math.max(1, Math.floor(regProf.limits.toolWallMs / 1000))
        : defaultWallSec;
      map.set(role.id, {
        id: role.id,
        adapter: role.adapter === 'pi' ? 'pi' : 'delegated',
        purpose: 'task',
        tools: role.tools as readonly TaskpackToolName[],
        maxTimeoutSeconds: regMaxSec,
        provider: role.provider,
        defaultModel: role.model,
        thinking: role.thinking,
      });
    }
  }

  return map;
}

function resolveDeclaredModels(
  taskpack: TaskpackManifest | undefined,
): Map<string, { readonly provider: string; readonly model: string; readonly thinking: string }> {
  const allowed = new Map<string, { readonly provider: string; readonly model: string; readonly thinking: string }>();
  if (taskpack?.spec.models !== undefined) {
    for (const m of taskpack.spec.models) {
      const entry = { provider: m.provider, model: m.id, thinking: m.thinking ?? 'medium' };
      allowed.set(m.id, entry);
      allowed.set(`${m.provider}/${m.id}`, entry);
    }
  }
  if (taskpack?.spec.roles !== undefined) {
    for (const r of taskpack.spec.roles) {
      if (r.model !== undefined && r.provider !== undefined) {
        const entry = { provider: r.provider, model: r.model, thinking: r.thinking ?? 'medium' };
        allowed.set(r.model, entry);
        allowed.set(`${r.provider}/${r.model}`, entry);
      }
    }
  }
  return allowed;
}

function mapHandoffSourceForCore(h: StepHandoffSelector): StepHandoffSelector {
  const rawKind = (h.source as { readonly kind: string }).kind;
  const normalizedSource: StepHandoffSelector['source'] = rawKind === 'assistant_final'
    ? { kind: 'submission' }
    : h.source.kind === 'artifact'
      ? { kind: 'artifact', path: h.source.path }
      : { kind: h.source.kind };
  const normalizedSelect: StepHandoffSelector['select'] = h.select.kind === 'markdown_heading'
    ? {
      kind: 'markdown_heading',
      heading: h.select.heading,
      ...(h.select.includeSubheadings !== undefined ? { includeSubheadings: h.select.includeSubheadings } : {}),
    }
    : h.select.kind === 'json_pointer'
      ? { kind: 'json_pointer', pointers: [...h.select.pointers] }
      : { kind: 'full' };

  return {
    ...(h.id !== undefined ? { id: h.id } : {}),
    fromStep: h.fromStep,
    source: normalizedSource,
    select: normalizedSelect,
    ...(h.maxBytes !== undefined ? { maxBytes: h.maxBytes } : {}),
    ...(h.required !== undefined ? { required: h.required } : {}),
  };
}

/**
 * Validate a supervisor `team-patch.v1` payload strictly against all 4 Archetype Capability Envelope
 * invariants and compile it into a deterministic child `TaskContract` with pre-verified `D <= 256` capacity.
 */
export function validateAndCompileTeamPatch(input: ValidateAndCompileTeamPatchInput): CompiledTeamPatchResult {
  const scrubber = input.scrubber ?? DEFAULT_SUPERVISOR_SCRUBBER;

  if (typeof input.rawPatch === 'object' && input.rawPatch !== null && !(input.rawPatch instanceof Uint8Array)) {
    inspectForbiddenAuthorityKeys(input.rawPatch, '');
  } else if (typeof input.rawPatch === 'string' || input.rawPatch instanceof Uint8Array) {
    const text = typeof input.rawPatch === 'string'
      ? input.rawPatch
      : new TextDecoder('utf-8', { fatal: false }).decode(input.rawPatch);
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      let maybeJson: NullProtoJson | null;
      try {
        maybeJson = parseNullProtoJson(trimmed, TEAM_PATCH_MAX_BYTES, '');
      } catch {
        maybeJson = null;
      }
      if (maybeJson !== null) {
        inspectForbiddenAuthorityKeys(maybeJson, '');
      }
    }
  }

  // Strict schema parse (zero Markdown regex scraping!)
  const patch = parseTeamPatchV1(input.rawPatch, { scrubber });

  if (patch.roles.length > input.teamEvolution.maxTeamSize) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      `team patch declares ${patch.roles.length} roles, exceeding maxTeamSize ${input.teamEvolution.maxTeamSize}`,
      '/roles',
    );
  }
  if (patch.steps.length > input.teamEvolution.maxTeamSteps) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      `team patch declares ${patch.steps.length} steps, exceeding maxTeamSteps ${input.teamEvolution.maxTeamSteps}`,
      '/steps',
    );
  }

  const allowedArchetypeSet = new Set(input.teamEvolution.allowedArchetypeRoles);
  const archetypes = resolveArchetypes(input);
  const declaredModels = resolveDeclaredModels(input.taskpack);

  const mergedResourcesMap = new Map<string, PinnedContextResource>();
  for (const res of input.baseTaskContract.spec.trustedContext.resources) {
    mergedResourcesMap.set(res.id, res);
  }
  for (const extra of input.extraPinnedResources ?? []) {
    mergedResourcesMap.set(extra.id, extra);
  }
  const mergedResources = [...mergedResourcesMap.values()];

  const resolvedRoleModels: Record<string, CompiledRoleModelBinding> =
    Object.create(null) as Record<string, CompiledRoleModelBinding>;
  const archetypeByPatchRoleId = new Map<string, string>();

  type CoreRoleSpec = TaskContract['spec']['roles'][number];
  const compiledRoles: CoreRoleSpec[] = [];

  for (let i = 0; i < patch.roles.length; i += 1) {
    const role = patch.roles[i]!;
    const rolePath = `/roles/${i}`;

    if (role.id === input.teamEvolution.supervisorRoleId || role.archetypeRoleId === input.teamEvolution.supervisorRoleId) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `role "${role.id}" cannot impersonate or inherit supervisor role "${input.teamEvolution.supervisorRoleId}"`,
        rolePath,
      );
    }

    // Invariant 1: Approved archetype inheritance
    if (!allowedArchetypeSet.has(role.archetypeRoleId)) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `role "${role.id}" archetypeRoleId "${role.archetypeRoleId}" is not in teamEvolution.allowedArchetypeRoles`,
        `${rolePath}/archetypeRoleId`,
      );
    }
    const archetype = archetypes.get(role.archetypeRoleId);
    if (archetype === undefined) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `role "${role.id}" archetypeRoleId "${role.archetypeRoleId}" does not resolve to an approved host archetype`,
        `${rolePath}/archetypeRoleId`,
      );
    }
    archetypeByPatchRoleId.set(role.id, archetype.id);

    if (archetype.purpose === 'review' && role.purpose !== 'review') {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `role "${role.id}" cannot escalate review archetype "${archetype.id}" to purpose "${role.purpose}"`,
        `${rolePath}/purpose`,
      );
    }

    // Invariant 2: Monotonic tool narrowing (tools <= archetype.tools) & read-only / review protection
    const archetypeToolSet = new Set<string>(archetype.tools);
    const archetypeIsReadOnly = !archetype.tools.some(t => MUTATING_OR_EXEC_TOOLS.has(t));
    for (const tool of role.tools) {
      if (!archetypeToolSet.has(tool)) {
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `role "${role.id}" widens tool "${tool}" beyond archetype "${archetype.id}" (${archetype.tools.join(', ')})`,
          `${rolePath}/tools`,
        );
      }
      if ((role.purpose === 'review' || archetype.purpose === 'review' || archetypeIsReadOnly) && MUTATING_OR_EXEC_TOOLS.has(tool)) {
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `role "${role.id}" cannot request mutating or exec tool "${tool}" on read-only/review envelope`,
          `${rolePath}/tools`,
        );
      }
    }

    // Invariant 3: Pinned models, thinking, resources, and timeouts
    let baseModelBinding: { readonly provider: string; readonly model: string; readonly thinking: string };
    if (role.model !== undefined) {
      if (input.taskpack !== undefined) {
        const found = declaredModels.get(role.model);
        if (found === undefined) {
          throw new EvolutionError(
            'TEAM_ENVELOPE_VIOLATION',
            `role "${role.id}" model "${role.model}" is not declared in Taskpack.spec.models`,
            `${rolePath}/model`,
          );
        }
        baseModelBinding = found;
      } else {
        baseModelBinding = {
          provider: archetype.provider ?? 'delegated',
          model: role.model,
          thinking: archetype.thinking ?? 'medium',
        };
      }
    } else {
      baseModelBinding = {
        provider: archetype.provider ?? 'delegated',
        model: archetype.defaultModel ?? 'default',
        thinking: archetype.thinking ?? 'medium',
      };
    }

    if (role.timeoutSeconds !== undefined && role.timeoutSeconds > archetype.maxTimeoutSeconds) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `role "${role.id}" timeoutSeconds (${role.timeoutSeconds}) exceeds archetype "${archetype.id}" ceiling (${archetype.maxTimeoutSeconds}s)`,
        `${rolePath}/timeoutSeconds`,
      );
    }

    const effectiveThinking = role.thinking ?? baseModelBinding.thinking;
    const modelBinding: CompiledRoleModelBinding = {
      provider: baseModelBinding.provider,
      model: baseModelBinding.model,
      thinking: effectiveThinking,
      ...(role.timeoutSeconds !== undefined ? { timeoutSeconds: role.timeoutSeconds } : {}),
    };
    resolvedRoleModels[role.id] = modelBinding;

    if (role.resourceIds !== undefined) {
      for (const resId of role.resourceIds) {
        if (!mergedResourcesMap.has(resId)) {
          throw new EvolutionError(
            'TEAM_ENVELOPE_VIOLATION',
            `role "${role.id}" references unpinned resource "${resId}" absent from TaskContract.spec.trustedContext.resources`,
            `${rolePath}/resourceIds`,
          );
        }
      }
    }

    compiledRoles.push({
      id: role.id,
      adapter: archetype.adapter,
      provider: modelBinding.provider,
      model: modelBinding.model,
      thinking: modelBinding.thinking,
      tools: [...role.tools] as TaskContract['spec']['roles'][number]['tools'][number][],
      ...(role.resourceIds !== undefined ? { resourceIds: [...role.resourceIds] } : {}),
    });
  }

  // Invariant 4: Isolated StepHandoffSelector relay, locked check steps, and D <= 256 precheck
  type CoreStepSpec = TaskContract['spec']['steps'][number];
  const baseCheckSteps = input.baseTaskContract.spec.steps.filter(s => s.kind === 'check');
  const reservedCheckIds = new Set<string>([
    ...baseCheckSteps.map(s => s.id),
    ...input.baseTaskContract.spec.acceptance.checks.map(c => c.id),
  ]);

  const roleById = new Map(compiledRoles.map(r => [r.id, r] as const));
  const usedRoles = new Set<string>();
  const patchStepById = new Map(patch.steps.map(s => [s.id, s] as const));

  for (let i = 0; i < patch.steps.length; i += 1) {
    const step = patch.steps[i]!;
    const stepPath = `/steps/${i}`;
    if (reservedCheckIds.has(step.id)) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `patch step "${step.id}" collides with locked acceptance check identifier`,
        `${stepPath}/id`,
      );
    }
    if (!roleById.has(step.roleId)) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `patch step "${step.id}" references unknown role "${step.roleId}"`,
        `${stepPath}/roleId`,
      );
    }
    usedRoles.add(step.roleId);
    for (const dep of step.dependsOn) {
      if (!patchStepById.has(dep) || dep === step.id) {
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `patch step "${step.id}" depends on unknown or self step "${dep}"`,
          `${stepPath}/dependsOn`,
        );
      }
    }
  }

  if (usedRoles.size !== compiledRoles.length) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      'every declared role in team-patch.v1 must be bound to at least one step',
      '/roles',
    );
  }

  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const s of patch.steps) {
    inDegree.set(s.id, s.dependsOn.length);
    children.set(s.id, []);
  }
  for (const s of patch.steps) {
    for (const dep of s.dependsOn) {
      children.get(dep)!.push(s.id);
    }
  }
  const queue = patch.steps.filter(s => s.dependsOn.length === 0).map(s => s.id);
  const topoOrder: string[] = [];
  const ancestors = new Map<string, Set<string>>(patch.steps.map(s => [s.id, new Set<string>()] as const));

  while (queue.length > 0) {
    const cur = queue.shift()!;
    topoOrder.push(cur);
    const curAnc = ancestors.get(cur)!;
    for (const next of children.get(cur) ?? []) {
      const nextAnc = ancestors.get(next)!;
      nextAnc.add(cur);
      for (const a of curAnc) nextAnc.add(a);
      const deg = inDegree.get(next)! - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (topoOrder.length !== patch.steps.length) {
    throw new EvolutionError('TEAM_ENVELOPE_VIOLATION', 'team-patch.v1 steps contain a dependency cycle', '/steps');
  }

  const compiledAgentSteps: CoreStepSpec[] = [];
  for (const stepId of topoOrder) {
    const s = patchStepById.get(stepId)!;
    const stepAnc = ancestors.get(stepId)!;
    let mappedHandoffs: StepHandoffSelector[] | undefined;
    if (s.handoffs !== undefined && s.handoffs.length > 0) {
      mappedHandoffs = [];
      for (const h of s.handoffs) {
        if (!stepAnc.has(h.fromStep)) {
          throw new EvolutionError(
            'TEAM_ENVELOPE_VIOLATION',
            `step "${s.id}" handoff fromStep "${h.fromStep}" must be an upstream dependency`,
            '/steps',
          );
        }
        mappedHandoffs.push(mapHandoffSourceForCore(h));
      }
    }
    if (s.onRework !== undefined && !stepAnc.has(s.onRework.rejectTo)) {
      throw new EvolutionError(
        'TEAM_ENVELOPE_VIOLATION',
        `step "${s.id}" onRework.rejectTo "${s.onRework.rejectTo}" must be a strict upstream dependency`,
        '/steps',
      );
    }
    compiledAgentSteps.push({
      id: s.id,
      kind: 'agent',
      uses: sanitizeIdentifier(`handler.${s.roleId}`, `handler-${s.roleId}`),
      roleId: s.roleId,
      dependsOn: [...s.dependsOn],
      ...(s.onRework !== undefined ? { onRework: { rejectTo: s.onRework.rejectTo, maxReworks: s.onRework.maxReworks } } : {}),
      ...(mappedHandoffs !== undefined ? { handoffs: mappedHandoffs } : {}),
    });
  }

  const sinkAgentIds = patch.steps
    .filter(s => (children.get(s.id)?.length ?? 0) === 0)
    .map(s => s.id);

  const baseCheckStepIds = new Set(baseCheckSteps.map(s => s.id));
  const compiledCheckSteps: CoreStepSpec[] = baseCheckSteps.length > 0
    ? baseCheckSteps.map(cs => {
      const keptCheckDeps = cs.dependsOn.filter(dep => baseCheckStepIds.has(dep));
      const nextDeps = keptCheckDeps.length > 0 ? keptCheckDeps : [...sinkAgentIds];
      return {
        id: cs.id,
        kind: 'check' as const,
        uses: cs.uses,
        roleId: null,
        dependsOn: nextDeps,
        ...(cs.onRework !== undefined ? { onRework: cs.onRework } : {}),
      };
    })
    : input.baseTaskContract.spec.acceptance.checks.map((chk, idx, arr) => ({
      id: sanitizeIdentifier(`check.${chk.id}`, `check-${idx}`),
      kind: 'check' as const,
      uses: chk.id,
      roleId: null,
      dependsOn: idx === 0
        ? [...sinkAgentIds]
        : [sanitizeIdentifier(`check.${arr[idx - 1]!.id}`, `check-${idx - 1}`)],
    }));

  const allOrderedSteps: readonly CoreStepSpec[] = [...compiledAgentSteps, ...compiledCheckSteps];
  const isMutatingRoleId = (rId: string | null): boolean => {
    if (rId === null) return false;
    const declared = roleById.get(rId);
    return Boolean(declared?.tools.some(t => MUTATING_OR_EXEC_TOOLS.has(t)));
  };
  const computeReworkSubgraphIds = (rejectToId: string): ReadonlySet<string> => {
    const found = new Set<string>([rejectToId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of allOrderedSteps) {
        if (!found.has(node.id) && node.dependsOn.some(parent => found.has(parent))) {
          found.add(node.id);
          changed = true;
        }
      }
    }
    return found;
  };

  let reworkGenerations = 0;
  let checkReworkGenerations = 0;
  for (const node of allOrderedSteps) {
    if (node.onRework !== undefined) {
      const subIds = computeReworkSubgraphIds(node.onRework.rejectTo);
      const mutatingSubSteps = allOrderedSteps.filter(
        item => subIds.has(item.id) && item.kind === 'agent' && isMutatingRoleId(item.roleId),
      ).length;
      reworkGenerations += node.onRework.maxReworks * (1 + mutatingSubSteps);
      if (node.kind === 'check') {
        checkReworkGenerations += node.onRework.maxReworks;
      }
    }
  }

  const totalStepsCount = allOrderedSteps.length;
  const N = compiledAgentSteps.length;
  const I = input.baseTaskContract.spec.budgets.maxImplementationRepairs;
  const C = input.baseTaskContract.spec.acceptance.checks.length + 2;
  const K = checkReworkGenerations;
  const A = input.maxAttempts ?? Math.min(64, Math.max(1, N + reworkGenerations + I + input.baseTaskContract.spec.budgets.maxFormatRepairs));
  const publicationEnabled = input.publicationEnabled === true;

  if (A < 1 || A > 64 || C < 2 || C > 34) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      `compiled team-patch.v1 violates controller bounds (A=${A}, C=${C})`,
      '/steps',
    );
  }

  const capacity = computePatchCheckpointCapacity({
    maxAttempts: A,
    agentStepsCount: N,
    maxImplementationRepairs: I,
    verifierSlotCount: C,
    publicationEnabled,
    reworkGenerations,
    checkReworkGenerations: K,
  });

  const proposedModelCalls = Math.max(input.baseTaskContract.spec.budgets.maxModelCalls, N + reworkGenerations);

  if (
    compiledRoles.length > 16
    || totalStepsCount > 16
    || capacity.D > 256
    || proposedModelCalls > 1024
    || proposedModelCalls + capacity.J + (publicationEnabled ? 2 : 0) + 3 * capacity.A > 2048
  ) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      `compiled team-patch.v1 exceeds controller checkpoint capacity envelope (D=${capacity.D}, steps=${totalStepsCount}, roles=${compiledRoles.length})`,
      '/steps',
    );
  }

  const rawCompiledContract = {
    apiVersion: input.baseTaskContract.apiVersion,
    kind: input.baseTaskContract.kind,
    spec: {
      goal: input.baseTaskContract.spec.goal,
      taskpack: input.baseTaskContract.spec.taskpack,
      target: input.baseTaskContract.spec.target,
      scope: {
        writable: [...input.baseTaskContract.spec.scope.writable],
        protected: [...input.baseTaskContract.spec.scope.protected],
      },
      roles: compiledRoles,
      trustedContext: {
        revision: input.baseTaskContract.spec.trustedContext.revision,
        discovery: 'disabled' as const,
        resources: mergedResources,
      },
      budgets: {
        ...input.baseTaskContract.spec.budgets,
        maxModelCalls: proposedModelCalls,
      },
      steps: [...compiledAgentSteps, ...compiledCheckSteps],
      acceptance: {
        required: [...input.baseTaskContract.spec.acceptance.required],
        checks: [...input.baseTaskContract.spec.acceptance.checks],
      },
    },
  };

  const validated = validateDocument(rawCompiledContract, 'TaskContract');
  if (!validated.ok) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      `compiled team-patch.v1 failed TaskContract validation: ${validated.errors[0]?.code ?? 'invalid'} at ${validated.errors[0]?.path ?? '/spec'}`,
      validated.errors[0]?.path ?? '/spec',
    );
  }

  // Post-compile defense-in-depth lock verification
  if (
    canonicalizeJson(validated.value.spec.scope) !== canonicalizeJson(input.baseTaskContract.spec.scope)
    || canonicalizeJson(validated.value.spec.acceptance) !== canonicalizeJson(input.baseTaskContract.spec.acceptance)
    || validated.value.spec.trustedContext.discovery !== 'disabled'
  ) {
    throw new EvolutionError(
      'TEAM_ENVELOPE_VIOLATION',
      'compiled team-patch.v1 diverged from locked scope or acceptance checks',
    );
  }

  let compiledRegistry: TrustedRegistry | undefined;
  if (input.trustedRegistry !== undefined) {
    const baseProfiles = input.trustedRegistry.spec.roleProfiles;
    const findBaseProfile = (archId: string) =>
      baseProfiles.find(
        p =>
          p.id === archId
          || p.id === `role.${archId}`
          || p.id === `taskpack.profile.${archId}`
          || (archId === 'author' && p.id === 'taskpack-author-role'),
      );
    const updatedRoleProfiles: TrustedRegistry['spec']['roleProfiles'][number][] = patch.roles.map(pr => {
      const baseProf = findBaseProfile(pr.archetypeRoleId) ?? baseProfiles[0]!;
      const binding = resolvedRoleModels[pr.id]!;
      const nextToolWallMs = pr.timeoutSeconds !== undefined
        ? Math.min(baseProf.limits?.toolWallMs ?? pr.timeoutSeconds * 1000, pr.timeoutSeconds * 1000)
        : baseProf.limits?.toolWallMs;
      return {
        ...baseProf,
        id: `taskpack.profile.${pr.id}`,
        selection: {
          ...baseProf.selection,
          provider: binding.provider,
          model: binding.model,
          thinking: binding.thinking,
        },
        tools: [...pr.tools],
        ...(baseProf.limits !== undefined || nextToolWallMs !== undefined
          ? {
            limits: {
              ...baseProf.limits,
              ...(nextToolWallMs !== undefined ? { toolWallMs: nextToolWallMs } : {}),
            },
          }
          : {}),
      } as TrustedRegistry['spec']['roleProfiles'][number];
    });
    compiledRegistry = {
      ...input.trustedRegistry,
      spec: {
        ...input.trustedRegistry.spec,
        roleProfiles: updatedRoleProfiles,
      },
    };
  }

  const canonicalPatchJson = canonicalizeJson(patch);
  const patchDigest = sha256Digest(canonicalPatchJson);

  return Object.freeze({
    patch,
    canonicalPatchJson,
    patchDigest,
    taskContract: validated.value,
    capacity,
    resolvedRoleModels: Object.freeze(resolvedRoleModels),
    ...(compiledRegistry !== undefined ? { compiledRegistry } : {}),
  });
}

/**
 * Create a fenced, strictly read-only child `LocalRunStore` plateau supervisor executor
 * (`<stagingDir>/controller`) enforcing `tools: ['read']`, `scope.protected: ['**', ...]`,
 * zero `held_out_workloads` mounts, and zero modified workspace files before accepting output.
 */
export function createLocalRunStoreSupervisorRunner(
  options: LocalRunStoreSupervisorRunnerOptions,
): SupervisorRunnerPort {
  const scrubber = options.scrubber ?? DEFAULT_SUPERVISOR_SCRUBBER;
  const envLookup = options.environment ?? ((name: string) => process.env[name]);

  return async (context: SupervisorExecutionContext): Promise<string | Uint8Array | Record<string, unknown>> => {
    const resolvedStagingDir = await realpath(await ensurePrivateNonSymlinkDir(context.stagingDir));
    const controllerRunRoot = join(resolvedStagingDir, 'controller');
    const configDir = join(resolvedStagingDir, 'config');
    const workspaceDir = join(resolvedStagingDir, 'workspace');
    await mkdir(controllerRunRoot, { recursive: true, mode: 0o700 });
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await mkdir(workspaceDir, { recursive: true, mode: 0o700 });

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Loopwright Supervisor',
      GIT_AUTHOR_EMAIL: 'supervisor@loopwright.dev',
      GIT_COMMITTER_NAME: 'Loopwright Supervisor',
      GIT_COMMITTER_EMAIL: 'supervisor@loopwright.dev',
    };
    if (!(await lstat(join(workspaceDir, '.git')).catch(() => null))) {
      execFileSync('git', ['init', '-b', 'main'], { cwd: workspaceDir, env: gitEnv, stdio: 'ignore' });
      execFileSync(
        'git',
        ['commit', '--allow-empty', '-m', 'Read-only plateau supervisor workspace'],
        { cwd: workspaceDir, env: gitEnv, stdio: 'ignore' },
      );
    }
    const workspaceHeadRev = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workspaceDir,
      env: gitEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .toLowerCase();

    const rawContract = context.supervisorContract;
    const contract: TaskContract = {
      ...rawContract,
      spec: {
        ...rawContract.spec,
        target: {
          ...rawContract.spec.target,
          baseRevision: workspaceHeadRev,
          sourceRevision: workspaceHeadRev,
        },
      },
    };
    if (contract.spec.roles.length !== 1) {
      throw new EvolutionError('TEAM_ENVELOPE_VIOLATION', 'supervisor TaskContract must declare exactly 1 role');
    }
    const supRole = contract.spec.roles[0]!;
    if (supRole.tools.length !== 1 || supRole.tools[0] !== 'read') {
      throw new EvolutionError('TEAM_ENVELOPE_VIOLATION', 'supervisor role must declare tools: ["read"] only');
    }
    if (!contract.spec.scope.protected.includes('**')) {
      throw new EvolutionError('TEAM_ENVELOPE_VIOLATION', 'supervisor TaskContract must protect "**" against mutations');
    }
    if (
      contract.spec.acceptance.checks.some(chk => chk.allowedEvidenceLevels.includes('hardware_execution'))
      || contract.spec.trustedContext.resources.some(r => r.path.includes('held_out_workloads'))
    ) {
      throw new EvolutionError('TEAM_ENVELOPE_VIOLATION', 'supervisor TaskContract must never bind hardware_execution or held_out_workloads');
    }

    const runId = sanitizeIdentifier(
      `sup-${context.campaignId}-i${context.island.islandId}-g${context.island.currentGeneration}-${randomBytes(3).toString('hex')}`,
      `sup-${randomBytes(4).toString('hex')}`,
    );

    const realTmpRoot = await realpath(tmpdir());
    const trustedTempDir = await mkdtemp(join(realTmpRoot, 'lw-evo-sup-reg-'));
    await chmod(trustedTempDir, 0o700);

    try {
      for (const stagedFile of context.files) {
        const dstPath = join(trustedTempDir, stagedFile.relativeResourcePath);
        await mkdir(dirname(dstPath), { recursive: true, mode: 0o700 });
        const rawBytes = await readFile(stagedFile.filePath);
        const rawText = rawBytes.toString('utf8');
        assertCleanSecrets(rawText, scrubber, stagedFile.relativeResourcePath);
        await writeFile(dstPath, rawBytes, { mode: 0o400 });
        await chmod(dstPath, 0o400);
      }

      const installed = await installedHandlerDigests();
      const agentStep = contract.spec.steps.find(s => s.kind === 'agent');
      if (agentStep === undefined) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'supervisor TaskContract missing agent step');
      }
      const profileId = sanitizeIdentifier(`profile.${supRole.id}`, 'profile-supervisor');
      const registryName = sanitizeIdentifier(`reg.${runId}`, 'reg-supervisor');

      const registryObj = {
        apiVersion: CONTROLLER_API_VERSION,
        kind: 'TrustedRegistry' as const,
        metadata: { name: registryName },
        spec: {
          version: 1 as const,
          resourceVersion: contract.spec.trustedContext.revision,
          handlers: [
            {
              id: agentStep.uses,
              version: 1 as const,
              digest: installed['pi.agent.v1'],
              kind: 'agent' as const,
              implementation: 'pi.agent.v1' as const,
              parameters: {
                prompt: contract.spec.goal,
                purpose: 'task' as const,
              },
              capabilities: ['pi'],
            },
            {
              id: 'supervisor-no-change',
              version: 1 as const,
              digest: installed['no-change.v1'],
              kind: 'check' as const,
              implementation: 'no-change.v1' as const,
              parameters: { checkId: 'supervisor-no-change' },
              capabilities: ['inert_bytes', 'read_only'],
            },
            {
              id: 'implicit-scope',
              version: 1 as const,
              digest: installed['scope.v1'],
              kind: 'check' as const,
              implementation: 'scope.v1' as const,
              parameters: { checkId: null },
              capabilities: ['inert_bytes', 'read_only'],
            },
            {
              id: 'implicit-no-change',
              version: 1 as const,
              digest: installed['no-change.v1'],
              kind: 'check' as const,
              implementation: 'no-change.v1' as const,
              parameters: { checkId: null },
              capabilities: ['inert_bytes', 'read_only'],
            },
          ],
          roleProfiles: [
            {
              id: profileId,
              adapter: 'delegated' as const,
              selection: {
                provider: supRole.provider,
                model: supRole.model,
                thinking: supRole.thinking,
              },
              tools: ['read'],
              limits: {
                toolWallMs: 60_000,
              },
              runtimeRef: null,
              providerCredentialRef: null,
              mcp: null,
            },
          ],
          resources: contract.spec.trustedContext.resources.map(r => ({
            id: r.id,
            kind: r.kind,
            path: r.path,
            digest: r.digest,
          })),
          runtimeProfiles: [],
          credentialBindings: [],
          environmentBindings: [],
          gateEndpoints: [],
          publicationEndpoints: [],
        },
      };

      const registryBytes = Buffer.from(`${JSON.stringify(registryObj, null, 2)}\n`, 'utf8');
      const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');
      const registryPath = join(trustedTempDir, 'registry.json');
      await writeFile(registryPath, registryBytes, { mode: 0o600 });
      await chmod(registryPath, 0o600);

      const drainReserveMs = Math.max(5_000, Math.min(30_000, Math.floor(contract.spec.budgets.wallTimeMs / 4)));
      const configObj = {
        apiVersion: CONTROLLER_API_VERSION,
        kind: 'ControllerConfig' as const,
        spec: {
          task: contract,
          registry: {
            name: registryName,
            digest: { algorithm: 'sha256' as const, hex: registrySha256 },
          },
          profiles: {
            roles: [{ roleId: supRole.id, profileRef: profileId }],
            steps: [
              { stepId: agentStep.id, handlerRef: agentStep.uses },
              { stepId: 'check-supervisor-readonly', handlerRef: 'supervisor-no-change' },
            ],
          },
          credentials: [],
          controls: {
            drainReserveMs,
            maxAttempts: 1,
            repeatFailureLimit: 2,
            submission: { mode: 'artifact_or_assistant' as const, path: null },
          },
          publication: { mode: 'disabled' as const },
        },
      };

      const configBytes = Buffer.from(`${JSON.stringify(configObj, null, 2)}\n`, 'utf8');
      const configPath = join(configDir, 'config.json');
      await writeFile(configPath, configBytes, { mode: 0o600 });
      await chmod(configPath, 0o600);

      const loadedRes = await loadTrustedConfiguration({
        configPath,
        registryPath,
        registrySha256,
        untrustedRoots: [workspaceDir],
        environment: envLookup,
      });
      if (!loadedRes.ok) {
        throw new EvolutionError(
          'EVOLUTION_STORE_ERROR',
          `supervisor child loadTrustedConfiguration failed: ${loadedRes.error.code} (${loadedRes.error.path})`,
        );
      }

      const tickRes = await stepNext({
        configuration: loadedRes.value,
        repository: workspaceDir,
        runRoot: controllerRunRoot,
        runId,
        mode: 'no-change',
        policyProfile: options.policyProfile ?? 'local',
        allowWorkflowWrites: false,
        environment: envLookup,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!tickRes.ok) {
        throw new EvolutionError('EVOLUTION_STORE_ERROR', `supervisor child stepNext failed: ${tickRes.error.code}`);
      }
      if (tickRes.value.kind !== 'step') {
        throw new EvolutionError('EVOLUTION_STORE_ERROR', 'supervisor child stepNext did not yield expected read-only step');
      }

      const tick = tickRes.value;
      const rawOutput = await options.executeReadOnlySupervisorTurn({
        ...context,
        runRoot: controllerRunRoot,
        runId,
        stepId: tick.stepId,
        roleId: tick.roleId,
        candidateDir: tick.candidateDir,
        contextFiles: tick.contextFiles,
        leaseToken: tick.leaseToken,
        tools: Object.freeze(['read'] as const),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });

      const candidateEntries = await readdir(tick.candidateDir);
      if (candidateEntries.length > 0) {
        await stepCancel({ runRoot: controllerRunRoot, runId, environment: envLookup }).catch(() => undefined);
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `read-only supervisor turn illegally created or modified workspace files: ${candidateEntries.join(', ')}`,
          '/scope/writable',
        );
      }

      const submitRes = await stepSubmit({
        runRoot: controllerRunRoot,
        runId,
        leaseToken: tick.leaseToken,
        status: 'no_change',
        reason: 'read-only plateau supervisor diagnosis completed',
        environment: envLookup,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (!submitRes.ok) {
        await stepCancel({ runRoot: controllerRunRoot, runId, environment: envLookup }).catch(() => undefined);
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `supervisor child stepSubmit refused (${submitRes.error.code} at ${submitRes.error.path})`,
        );
      }
      if (
        submitRes.value.kind !== 'result'
        || (submitRes.value.result.spec.status !== 'no_change' && submitRes.value.result.spec.status !== 'completed')
      ) {
        await stepCancel({ runRoot: controllerRunRoot, runId, environment: envLookup }).catch(() => undefined);
        throw new EvolutionError(
          'TEAM_ENVELOPE_VIOLATION',
          `supervisor child run failed read-only no-change verification`,
        );
      }

      return rawOutput;
    } finally {
      await rm(trustedTempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/**
 * Record a child generation outcome against an island's `'trial'` `TeamConfigRecord`, promoting on
 * Pareto/niche advance, auto-rolling back when `trialGenerations` expire without gain, and ignoring
 * `BENCHMARK_PREEMPTED` runs (`preempted: true`).
 */
export async function recordTeamTrialOutcome(
  store: EvolutionCampaignStore,
  lease: CampaignLease,
  input: RecordTeamTrialOutcomeInput,
): Promise<TeamTrialOutcomeResult> {
  const before = await store.getTeamConfig(input.teamConfigId);
  if (before === null) {
    throw new EvolutionError('EVOLUTION_NOT_FOUND', `team_config "${input.teamConfigId}" not found`);
  }
  const previousStatus = before.status;
  const ignoredPreemption = input.preempted === true;

  const updated = await store.recordTeamTrialGeneration(lease, {
    teamConfigId: input.teamConfigId,
    advancedPareto: input.advancedPareto,
    discoveredNiche: input.discoveredNiche,
    ...(input.preempted !== undefined ? { preempted: input.preempted } : {}),
  });

  const island = await store.getIsland(input.campaignId, input.islandId);
  const activeTeamConfigId = island?.activeTeamConfigId ?? updated.teamConfigId;

  return Object.freeze({
    teamConfig: updated,
    previousStatus,
    nextStatus: updated.status,
    activeTeamConfigId,
    promoted: previousStatus === 'trial' && updated.status === 'promoted',
    rolledBack: previousStatus === 'trial' && updated.status === 'rolled_back',
    ignoredPreemption,
  });
}

/**
 * Run an event-driven plateau / loop-pathology supervisor turn on an island.
 * Keeps the incumbent `activeTeamConfigId` active without crashing the campaign if the supervisor
 * output fails schema validation (`EVOLUTION_SCHEMA_INVALID`) or violates the Archetype Capability
 * Envelope (`TEAM_ENVELOPE_VIOLATION`).
 */
export async function runPlateauSupervisorTurn(
  input: RunPlateauSupervisorTurnInput,
): Promise<PlateauSupervisorTurnResult> {
  const currentTeam = await input.store.getTeamConfig(input.island.activeTeamConfigId);
  const decision = evaluateTeamEvolutionTrigger({
    ...(input.teamEvolution !== undefined ? { teamEvolution: input.teamEvolution } : {}),
    island: input.island,
    budgets: input.budgets,
    evaluationsUsed: input.evaluationsUsed,
    currentGeneration: input.currentGeneration,
    ...(input.recentRunEvals !== undefined ? { recentRunEvals: input.recentRunEvals } : {}),
    ...(currentTeam?.status !== undefined ? { activeTeamStatus: currentTeam.status } : {}),
  });

  if (!decision.shouldInvoke || input.teamEvolution === undefined || decision.triggerReason === undefined) {
    return Object.freeze({
      invoked: false,
      accepted: false,
      decision,
      activeTeamConfigId: input.island.activeTeamConfigId,
    });
  }

  const teamHistory = await input.store.listTeamConfigs(input.campaignId, input.island.islandId);
  const stagedContext = await stageSupervisorContext({
    stagingDir: input.stagingDir,
    campaignId: input.campaignId,
    island: input.island,
    triggerReason: decision.triggerReason,
    teamEvolution: input.teamEvolution,
    baseTaskContract: input.baseTaskContract,
    trajectory: input.trajectory,
    recentRunEvals: input.recentRunEvals,
    recentIndividuals: input.recentIndividuals,
    latestScratchpadMarkdown: input.latestScratchpadMarkdown,
    teamHistory,
    scrubber: input.scrubber,
  });

  let compiledPatch: CompiledTeamPatchResult;
  try {
    const rawSupervisorOutput = await input.supervisorRunner({
      campaignId: input.campaignId,
      island: input.island,
      triggerReason: decision.triggerReason,
      stagingDir: stagedContext.stagingDir,
      files: stagedContext.files,
      supervisorContract: stagedContext.supervisorContract,
      writablePaths: stagedContext.writablePaths,
      prompt: stagedContext.prompt,
    });

    compiledPatch = validateAndCompileTeamPatch({
      rawPatch: rawSupervisorOutput,
      teamEvolution: input.teamEvolution,
      baseTaskContract: input.baseTaskContract,
      taskpack: input.taskpack,
      trustedRegistry: input.trustedRegistry,
      archetypes: input.archetypes,
      extraPinnedResources: input.extraPinnedResources,
      scrubber: input.scrubber,
    });
  } catch (err: unknown) {
    if (
      err instanceof EvolutionError
      && (err.code === 'TEAM_ENVELOPE_VIOLATION' || err.code === 'EVOLUTION_SCHEMA_INVALID')
    ) {
      return Object.freeze({
        invoked: true,
        accepted: false,
        decision,
        activeTeamConfigId: input.island.activeTeamConfigId,
        stagedContext,
        error: err,
      });
    }
    throw err;
  }

  const casBlob = await input.store.writeCasBlob(Buffer.from(`${compiledPatch.canonicalPatchJson}\n`, 'utf8'));
  const teamConfigId = `${input.campaignId}:isl-${input.island.islandId}:gen-${input.currentGeneration}:${casBlob.digest.hex.slice(0, 12)}`.slice(
    0,
    128,
  );

  const trialTeam = await input.store.createTrialTeamConfig(input.lease, {
    teamConfigId,
    campaignId: input.campaignId,
    islandId: input.island.islandId,
    parentTeamConfigId: input.island.activeTeamConfigId,
    createdGeneration: input.currentGeneration,
    trialBudgetGenerations: input.teamEvolution.trialGenerations,
    diagnosis: compiledPatch.patch.diagnosis,
    patchCasDigest: casBlob.digest,
  });

  await input.store.updateIslandProgress(input.lease, {
    campaignId: input.campaignId,
    islandId: input.island.islandId,
    activeTeamConfigId: trialTeam.teamConfigId,
    consecutiveNoGainGenerations: 0,
    consecutivePathologyRuns: 0,
  });

  return Object.freeze({
    invoked: true,
    accepted: true,
    decision,
    activeTeamConfigId: trialTeam.teamConfigId,
    teamConfig: trialTeam,
    compiledPatch,
    stagedContext,
  });
}
