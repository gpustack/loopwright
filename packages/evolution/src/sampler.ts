import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SecretScrubber, type Digest } from '@loopwright/core';
import { computeMedianFitness } from './pareto.js';
import { canonicalizeJson } from './schema.js';
import {
  CONTEXT_SLICE_MAX_BYTES,
  EvolutionError,
  type EvolutionModelBanditStrategy,
  type IndividualRecord,
  type LineageRole,
  type ModelBanditArmRecord,
} from './types.js';

const DEFAULT_SECRET_SCRUBBER = new SecretScrubber();
const DEFAULT_SLICE_MAX_BYTES = 16_384;
const DEFAULT_UCB1_EXPLORATION_C = Math.SQRT2;
const DEFAULT_REWARD_MAX_EXPONENT = 20;

/**
 * Stepping-stone novelty-decayed parent sampling weight:
 * $w_i = \sigma(\lambda(F(P_i) - \alpha_0)) \cdot (1 + N(P_i))^{-1}$.
 */
export function computeSteppingStoneSamplingWeight(
  fitness: number,
  islandMedianFitness: number,
  offspringCount: number,
  noveltyDecayLambda: number,
): number {
  if (
    !Number.isFinite(fitness)
    || !Number.isFinite(islandMedianFitness)
    || !Number.isFinite(offspringCount)
    || !Number.isFinite(noveltyDecayLambda)
  ) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'stepping-stone weight inputs must be finite numbers');
  }
  const scaled = Math.max(-60, Math.min(60, noveltyDecayLambda * (fitness - islandMedianFitness)));
  const performanceScore = 1 / (1 + Math.exp(-scaled));
  const noveltyFactor = 1 / (1 + Math.max(0, offspringCount));
  return performanceScore * noveltyFactor;
}

function rotl32(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * Create a deterministic `xoshiro128**` pseudo-random generator in `[0, 1)` seeded via SHA-256.
 */
export function createSeededPrng(seed: string | Uint8Array): () => number {
  const digest = typeof seed === 'string'
    ? createHash('sha256').update(seed, 'utf8').digest()
    : createHash('sha256').update(seed).digest();

  let s0 = digest.readUInt32LE(0);
  let s1 = digest.readUInt32LE(4);
  let s2 = digest.readUInt32LE(8);
  let s3 = digest.readUInt32LE(12);
  if ((s0 | s1 | s2 | s3) === 0) {
    s0 = 0x9e3779b9;
  }

  return (): number => {
    const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl32(s3, 11);
    return result / 4_294_967_296;
  };
}

export interface SampledParentEntry {
  readonly individual: IndividualRecord;
  readonly role: 'primary' | 'crossover_donor' | 'inspiration';
  readonly sourceIslandId: number;
  readonly weight: number;
}

export interface SampledParentSelection {
  readonly primary: SampledParentEntry;
  readonly secondary: readonly SampledParentEntry[];
  readonly islandMedianFitness: number;
}

export interface SampleParentsOptions {
  readonly islandId: number;
  readonly localCandidates: readonly IndividualRecord[];
  readonly inspirationCandidates?: readonly IndividualRecord[];
  readonly maxCrossoversPerPrompt: number;
  readonly noveltyDecayLambda: number;
  readonly seed: string | Uint8Array;
}

function isFertileCandidate(ind: IndividualRecord): boolean {
  return ind.status === 'passed' || ind.status === 'soft_passed';
}

function resolveCandidateFitness(ind: IndividualRecord): number {
  return ind.scalarFitness !== null && Number.isFinite(ind.scalarFitness) ? ind.scalarFitness : 0;
}

function weightedPickIndex(weights: readonly number[], prng: () => number): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) {
    return Math.min(weights.length - 1, Math.floor(prng() * weights.length));
  }
  const threshold = prng() * total;
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i]!;
    if (threshold < cumulative) return i;
  }
  return weights.length - 1;
}

/**
 * Deterministically sample `1` local primary parent plus up to `maxCrossoversPerPrompt` (`0..4`)
 * distinct `crossover_donor` or `inspiration` parents using stepping-stone novelty-decayed weights.
 */
export function sampleParents(options: SampleParentsOptions): SampledParentSelection {
  if (!Number.isSafeInteger(options.maxCrossoversPerPrompt) || options.maxCrossoversPerPrompt < 0 || options.maxCrossoversPerPrompt > 4) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'maxCrossoversPerPrompt must be within 0..4');
  }
  if (!Number.isFinite(options.noveltyDecayLambda) || options.noveltyDecayLambda <= 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'noveltyDecayLambda must be > 0');
  }

  const fertileLocal = options.localCandidates
    .filter(c => isFertileCandidate(c) && c.islandId === options.islandId)
    .sort((a, b) => (a.individualId < b.individualId ? -1 : a.individualId > b.individualId ? 1 : 0));

  if (fertileLocal.length === 0) {
    throw new EvolutionError(
      'EVOLUTION_NOT_FOUND',
      `island ${options.islandId} has zero fertile local parent candidates`,
    );
  }

  const islandMedianFitness = computeMedianFitness(fertileLocal.map(c => resolveCandidateFitness(c)));
  const prng = createSeededPrng(options.seed);

  const localWeights = fertileLocal.map(c =>
    computeSteppingStoneSamplingWeight(
      resolveCandidateFitness(c),
      islandMedianFitness,
      c.offspringCount,
      options.noveltyDecayLambda,
    ),
  );
  const primaryIdx = weightedPickIndex(localWeights, prng);
  const primaryIndividual = fertileLocal[primaryIdx]!;
  const primary: SampledParentEntry = Object.freeze({
    individual: primaryIndividual,
    role: 'primary',
    sourceIslandId: primaryIndividual.islandId,
    weight: localWeights[primaryIdx]!,
  });

  const usedIds = new Set<string>([primaryIndividual.individualId]);
  const pool: SampledParentEntry[] = [];

  for (let i = 0; i < fertileLocal.length; i++) {
    const cand = fertileLocal[i]!;
    if (usedIds.has(cand.individualId)) continue;
    usedIds.add(cand.individualId);
    pool.push({
      individual: cand,
      role: 'crossover_donor',
      sourceIslandId: cand.islandId,
      weight: localWeights[i]!,
    });
  }

  const inspirations = (options.inspirationCandidates ?? [])
    .filter(c => isFertileCandidate(c))
    .sort((a, b) => (a.individualId < b.individualId ? -1 : a.individualId > b.individualId ? 1 : 0));
  for (const insp of inspirations) {
    if (usedIds.has(insp.individualId)) continue;
    usedIds.add(insp.individualId);
    const weight = computeSteppingStoneSamplingWeight(
      resolveCandidateFitness(insp),
      islandMedianFitness,
      insp.offspringCount,
      options.noveltyDecayLambda,
    );
    pool.push({
      individual: insp,
      role: 'inspiration',
      sourceIslandId: insp.islandId,
      weight,
    });
  }

  const secondary: SampledParentEntry[] = [];
  const targetSecondaryCount = Math.min(options.maxCrossoversPerPrompt, pool.length);
  for (let pick = 0; pick < targetSecondaryCount; pick++) {
    const idx = weightedPickIndex(pool.map(p => p.weight), prng);
    const chosen = pool.splice(idx, 1)[0]!;
    secondary.push(Object.freeze(chosen));
  }

  return Object.freeze({
    primary,
    secondary: Object.freeze(secondary),
    islandMedianFitness,
  });
}

// ---------------------------------------------------------------------------
// Island Elitism Ring Migration
// ---------------------------------------------------------------------------

export interface RingMigrationElite {
  readonly sourceIslandId: number;
  readonly targetIslandId: number;
  readonly individual: IndividualRecord;
  readonly role: 'inspiration';
}

export interface SelectRingMigrationOptions {
  readonly generation: number;
  readonly islands: number;
  readonly migrationIntervalGenerations: number;
  readonly maxMigrationElites: number;
  readonly individuals: readonly IndividualRecord[];
}

function compareEliteQuality(a: IndividualRecord, b: IndividualRecord): number {
  const rankA = a.paretoRank ?? Number.MAX_SAFE_INTEGER;
  const rankB = b.paretoRank ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;

  const fitA = a.scalarFitness ?? Number.NEGATIVE_INFINITY;
  const fitB = b.scalarFitness ?? Number.NEGATIVE_INFINITY;
  if (fitA !== fitB) return fitB - fitA;

  const crowdA = a.crowdingDistance ?? -1;
  const crowdB = b.crowdingDistance ?? -1;
  if (crowdA !== crowdB) return crowdB > crowdA ? 1 : -1;

  return a.individualId < b.individualId ? -1 : a.individualId > b.individualId ? 1 : 0;
}

/**
 * Select ring-migration elites across `(i + 1) % islands` on `migrationIntervalGenerations`
 * boundaries while strictly keeping every island's rank-1 leader(s) local (**Island Elitism**).
 */
export function selectRingMigrationElites(
  options: SelectRingMigrationOptions,
): readonly RingMigrationElite[] {
  if (
    !Number.isSafeInteger(options.islands) || options.islands < 1 || options.islands > 16
    || !Number.isSafeInteger(options.migrationIntervalGenerations) || options.migrationIntervalGenerations < 1
    || !Number.isSafeInteger(options.maxMigrationElites) || options.maxMigrationElites < 0
    || !Number.isSafeInteger(options.generation) || options.generation < 0
  ) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'invalid ring migration parameters');
  }

  if (
    options.islands <= 1
    || options.maxMigrationElites === 0
    || options.generation === 0
    || options.generation % options.migrationIntervalGenerations !== 0
  ) {
    return Object.freeze([]);
  }

  const migrations: RingMigrationElite[] = [];
  for (let sourceIslandId = 0; sourceIslandId < options.islands; sourceIslandId++) {
    const targetIslandId = (sourceIslandId + 1) % options.islands;
    const bestByNiche = new Map<string, IndividualRecord>();

    for (const ind of options.individuals) {
      if (ind.islandId !== sourceIslandId || !isFertileCandidate(ind) || ind.nicheKey === null) {
        continue;
      }
      const incumbent = bestByNiche.get(ind.nicheKey);
      if (!incumbent || compareEliteQuality(ind, incumbent) < 0) {
        bestByNiche.set(ind.nicheKey, ind);
      }
    }

    // Island Elitism: strictly exclude all rank-1 leaders (only paretoRank >= 2 may migrate).
    const nonRank1Elites = [...bestByNiche.values()]
      .filter(elite => elite.paretoRank !== null && elite.paretoRank > 1)
      .sort(compareEliteQuality);

    const selected = nonRank1Elites.slice(0, options.maxMigrationElites);
    for (const individual of selected) {
      migrations.push(
        Object.freeze({
          sourceIslandId,
          targetIslandId,
          individual,
          role: 'inspiration' as const,
        }),
      );
    }
  }

  return Object.freeze(migrations);
}

// ---------------------------------------------------------------------------
// Read-only (0o400) O_NOFOLLOW Multi-Parent Context File Staging
// ---------------------------------------------------------------------------

export interface ParentContextInput {
  readonly individual: IndividualRecord;
  readonly role: Exclude<LineageRole, 'portfolio_member'>;
  readonly codeSlice: string;
}

export interface StagedParentContextFile {
  readonly individualId: string;
  readonly role: Exclude<LineageRole, 'portfolio_member'>;
  readonly fileName: string;
  readonly filePath: string;
  readonly byteLength: number;
  readonly digest: Digest;
}

export interface StagedMultiParentContext {
  readonly stagingDir: string;
  readonly files: readonly StagedParentContextFile[];
}

export interface StageMultiParentContextOptions {
  readonly stagingDir: string;
  readonly parents: readonly ParentContextInput[];
  readonly maxCrossoversPerPrompt: number;
  readonly maxCodeSliceBytes?: number;
  readonly scrubber?: SecretScrubber;
}

function truncateUtf8ByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

async function ensureContextStagingDir(dirPath: string): Promise<void> {
  const existing = await lstat(dirPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${dirPath}`, dirPath);
    }
    throw err;
  });

  if (existing === null) {
    await mkdir(dirPath, { mode: 0o700, recursive: false }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  } else if (existing.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `stagingDir cannot be a symlink: ${dirPath}`, dirPath);
  } else if (!existing.isDirectory()) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `stagingDir must be a directory: ${dirPath}`, dirPath);
  }

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const dirFlag = 'O_DIRECTORY' in fsConstants ? fsConstants.O_DIRECTORY : 0;
  const handle = await open(dirPath, fsConstants.O_RDONLY | noFollow | dirFlag).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink stagingDir forbidden: ${dirPath}`, dirPath);
    }
    throw err;
  });
  await handle.close();
}

/**
 * Stage bounded, `SecretScrubber`-clean, `O_NOFOLLOW`, `0o400` read-only parent context files
 * containing bounded code slices, `bucketMetrics`, and `hardwareDiagnostics`.
 */
export async function stageMultiParentContextFiles(
  options: StageMultiParentContextOptions,
): Promise<StagedMultiParentContext> {
  if (!Number.isSafeInteger(options.maxCrossoversPerPrompt) || options.maxCrossoversPerPrompt < 0 || options.maxCrossoversPerPrompt > 4) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'maxCrossoversPerPrompt must be within 0..4');
  }
  const maxSliceBytes = options.maxCodeSliceBytes ?? DEFAULT_SLICE_MAX_BYTES;
  if (!Number.isSafeInteger(maxSliceBytes) || maxSliceBytes < 64 || maxSliceBytes > CONTEXT_SLICE_MAX_BYTES) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `maxCodeSliceBytes must be within 64..${CONTEXT_SLICE_MAX_BYTES}`);
  }
  if (options.parents.length < 1 || options.parents.length > 1 + options.maxCrossoversPerPrompt) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      `parents length must be within 1..${1 + options.maxCrossoversPerPrompt}`,
    );
  }

  const primaryCount = options.parents.filter(p => p.role === 'primary').length;
  if (primaryCount !== 1) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'parents must include exactly 1 primary parent');
  }

  const seenParentIds = new Set<string>();
  for (const parent of options.parents) {
    if (seenParentIds.has(parent.individual.individualId)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `duplicate parent individual "${parent.individual.individualId}"`);
    }
    seenParentIds.add(parent.individual.individualId);
  }

  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;
  const resolvedDir = resolve(options.stagingDir);
  await ensureContextStagingDir(resolvedDir);

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const files: StagedParentContextFile[] = [];

  for (let i = 0; i < options.parents.length; i++) {
    const item = options.parents[i]!;
    const boundedSlice = truncateUtf8ByBytes(item.codeSlice, maxSliceBytes);
    const payload: Record<string, unknown> = {
      individualId: item.individual.individualId,
      role: item.role,
      islandId: item.individual.islandId,
      generation: item.individual.generation,
      nicheKey: item.individual.nicheKey,
      paretoRank: item.individual.paretoRank,
      metrics: item.individual.metrics,
      codeSlice: boundedSlice,
      ...(item.individual.bucketMetrics !== undefined ? { bucketMetrics: item.individual.bucketMetrics } : {}),
      ...(item.individual.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: item.individual.hardwareDiagnostics } : {}),
    };

    const serialized = `${canonicalizeJson(payload)}\n`;
    if (scrubber.containsSecret(serialized)) {
      throw new EvolutionError(
        'SECRET_LEAK_DETECTED',
        `secret material detected in parent context for "${item.individual.individualId}"`,
      );
    }

    const safeSlug = item.individual.individualId.replace(/[^A-Za-z0-9._-]/g, '_');
    const fileName = `parent-${i}-${item.role}-${safeSlug}.json`;
    const finalPath = join(resolvedDir, fileName);

    const existing = await lstat(finalPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP') {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden at ${finalPath}`, finalPath);
      }
      throw err;
    });
    if (existing !== null) {
      if (existing.isSymbolicLink()) {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `target context file is a symlink: ${finalPath}`, finalPath);
      }
      throw new EvolutionError('EVOLUTION_CONFLICT', `context file already exists: ${finalPath}`, finalPath);
    }

    const bytes = Buffer.from(serialized, 'utf8');
    const hex = createHash('sha256').update(bytes).digest('hex');
    const tempPath = join(resolvedDir, `.tmp-${fileName}-${randomBytes(6).toString('hex')}`);

    const handle = await open(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o600,
    );
    try {
      let written = 0;
      while (written < bytes.byteLength) {
        const res = await handle.write(bytes, written, bytes.byteLength - written, written);
        written += res.bytesWritten;
      }
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw err;
    }
    await handle.close();

    try {
      await chmod(tempPath, 0o400);
      await rename(tempPath, finalPath);
    } catch (err) {
      await chmod(tempPath, 0o600).catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw err;
    }

    files.push(
      Object.freeze({
        individualId: item.individual.individualId,
        role: item.role,
        fileName,
        filePath: finalPath,
        byteLength: bytes.byteLength,
        digest: Object.freeze({ algorithm: 'sha256' as const, hex }),
      }),
    );
  }

  return Object.freeze({
    stagingDir: resolvedDir,
    files: Object.freeze(files),
  });
}

// ---------------------------------------------------------------------------
// Model Selector (`deterministic-round-robin` | `ucb1`) & Truncated Exp Reward
// ---------------------------------------------------------------------------

/**
 * Truncated parent-relative improvement reward:
 * $r_u = \exp(\max(r - r_{\text{parent}}, 0)) - 1$.
 */
export function computeTruncatedImprovementReward(
  childFitness: number,
  parentFitness: number,
  maxExponent = DEFAULT_REWARD_MAX_EXPONENT,
): number {
  if (!Number.isFinite(childFitness) || !Number.isFinite(parentFitness) || !Number.isFinite(maxExponent) || maxExponent <= 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'reward inputs must be finite numbers');
  }
  const improvement = Math.max(0, childFitness - parentFitness);
  if (improvement === 0) return 0;
  const clamped = Math.min(improvement, maxExponent);
  return Math.expm1(clamped);
}

export interface SelectModelCandidateOptions {
  readonly strategy: EvolutionModelBanditStrategy;
  readonly modelIds: readonly string[];
  readonly arms: readonly ModelBanditArmRecord[];
  readonly sequenceIndex: number;
  readonly explorationConstant?: number;
}

export interface SelectedModelCandidate {
  readonly modelId: string;
  readonly reason: 'round_robin' | 'initial_exploration' | 'ucb1_score';
  readonly score: number | null;
}

/**
 * Deterministically select the next model from `1..16` declared `modelIds` using
 * `'deterministic-round-robin'` or `'ucb1'`.
 */
export function selectModelCandidate(options: SelectModelCandidateOptions): SelectedModelCandidate {
  if (options.modelIds.length < 1 || options.modelIds.length > 16) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'modelIds length must be within 1..16');
  }
  if (!Number.isSafeInteger(options.sequenceIndex) || options.sequenceIndex < 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'sequenceIndex must be an integer >= 0');
  }
  const seenModels = new Set<string>();
  for (const modelId of options.modelIds) {
    if (typeof modelId !== 'string' || modelId.trim().length === 0) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'modelId must be a non-empty string');
    }
    if (seenModels.has(modelId)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `duplicate modelId "${modelId}"`);
    }
    seenModels.add(modelId);
  }

  if (options.strategy === 'deterministic-round-robin') {
    const chosen = options.modelIds[options.sequenceIndex % options.modelIds.length]!;
    return Object.freeze({
      modelId: chosen,
      reason: 'round_robin',
      score: null,
    });
  }

  const explorationC = options.explorationConstant ?? DEFAULT_UCB1_EXPLORATION_C;
  if (!Number.isFinite(explorationC) || explorationC <= 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'explorationConstant must be > 0');
  }

  const armByModel = new Map<string, ModelBanditArmRecord>();
  for (const arm of options.arms) {
    armByModel.set(arm.modelId, arm);
  }

  // Pull every unpulled arm once in deterministic declaration order first.
  for (const modelId of options.modelIds) {
    const arm = armByModel.get(modelId);
    if (!arm || arm.pullCount <= 0) {
      return Object.freeze({
        modelId,
        reason: 'initial_exploration',
        score: Number.POSITIVE_INFINITY,
      });
    }
  }

  let totalPulls = 0;
  for (const modelId of options.modelIds) {
    totalPulls += armByModel.get(modelId)!.pullCount;
  }

  let bestModelId = options.modelIds[0]!;
  let bestScore = Number.NEGATIVE_INFINITY;
  const logTotal = Math.log(Math.max(1, totalPulls));

  for (const modelId of options.modelIds) {
    const arm = armByModel.get(modelId)!;
    const bonus = explorationC * Math.sqrt(logTotal / arm.pullCount);
    const ucbScore = arm.meanReward + bonus;
    if (ucbScore > bestScore) {
      bestScore = ucbScore;
      bestModelId = modelId;
    }
  }

  return Object.freeze({
    modelId: bestModelId,
    reason: 'ucb1_score',
    score: bestScore,
  });
}
