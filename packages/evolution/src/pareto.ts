import type { HardwareDiagnostics, MetricValue } from '@loopwright/core';
import {
  EvolutionError,
  type EvolutionNicheAxis,
  type ObjectiveDirectionSpec,
} from './types.js';

export interface ParetoCandidateEntry {
  readonly individualId: string;
  readonly metrics: Readonly<Record<string, number>>;
}

export interface RankedParetoEntry {
  readonly individualId: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly paretoRank: number;
  readonly crowdingDistance: number;
}

export interface ObjectiveMetricStats {
  readonly min: number;
  readonly max: number;
  readonly weight?: number;
}

export type ObjectiveReferenceStats = Readonly<Record<string, ObjectiveMetricStats>>;

function getOwnFiniteMetric(
  record: Readonly<Record<string, number>>,
  metric: string,
): number | undefined {
  if (!Object.hasOwn(record, metric)) return undefined;
  const val = record[metric];
  if (typeof val !== 'number' || !Number.isFinite(val)) return undefined;
  return Object.is(val, -0) ? 0 : val;
}

/**
 * Return `true` iff `candidate` is at least as good as `incumbent` on every declared
 * objective and strictly better on at least one objective.
 */
export function dominatesObjectives(
  candidate: Readonly<Record<string, number>>,
  incumbent: Readonly<Record<string, number>>,
  objectives: readonly ObjectiveDirectionSpec[],
): boolean {
  if (objectives.length === 0) return false;
  let strictlyBetterInAtLeastOne = false;
  for (const obj of objectives) {
    const a = getOwnFiniteMetric(candidate, obj.metric);
    const b = getOwnFiniteMetric(incumbent, obj.metric);
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
      return false;
    }
    if (obj.direction === 'minimize') {
      if (a > b) return false;
      if (a < b) strictlyBetterInAtLeastOne = true;
    } else {
      if (a < b) return false;
      if (a > b) strictlyBetterInAtLeastOne = true;
    }
  }
  return strictlyBetterInAtLeastOne;
}

function normalizedMinVector(
  metrics: Readonly<Record<string, number>>,
  objectives: readonly ObjectiveDirectionSpec[],
  individualId: string,
): readonly number[] {
  const vec: number[] = [];
  for (const obj of objectives) {
    const raw = getOwnFiniteMetric(metrics, obj.metric);
    if (raw === undefined || Object.is(metrics[obj.metric], -0)) {
      throw new EvolutionError(
        'EVOLUTION_SCHEMA_INVALID',
        `individual "${individualId}" missing finite non-negative-zero metric "${obj.metric}"`,
      );
    }
    vec.push(obj.direction === 'minimize' ? raw : -raw);
  }
  return vec;
}

function compareLexicographicVectors(
  vecA: readonly number[],
  idA: string,
  vecB: readonly number[],
  idB: string,
): number {
  for (let i = 0; i < vecA.length; i++) {
    const a = vecA[i]!;
    const b = vecB[i]!;
    if (a !== b) return a < b ? -1 : 1;
  }
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

interface InternalCandidate {
  readonly entry: ParetoCandidateEntry;
  readonly normVec: readonly number[];
}

/**
 * Deterministic NSGA-II non-dominated sorting (`paretoRank = 1..k`) and crowding distance
 * computation with permutation-invariant tie-breaking by objective vector and `individualId`.
 */
export function computeNsga2Ranking(
  entries: readonly ParetoCandidateEntry[],
  objectives: readonly ObjectiveDirectionSpec[],
): readonly RankedParetoEntry[] {
  if (objectives.length === 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'objectives must contain at least 1 entry');
  }
  if (entries.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const canonical: InternalCandidate[] = [];
  for (const entry of entries) {
    if (typeof entry.individualId !== 'string' || entry.individualId.length === 0) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'individualId must be a non-empty string');
    }
    if (seenIds.has(entry.individualId)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `duplicate individualId "${entry.individualId}"`);
    }
    seenIds.add(entry.individualId);
    canonical.push({
      entry,
      normVec: normalizedMinVector(entry.metrics, objectives, entry.individualId),
    });
  }

  // Canonicalize order upfront so all downstream comparisons are 100% input-permutation-invariant.
  canonical.sort((a, b) =>
    compareLexicographicVectors(a.normVec, a.entry.individualId, b.normVec, b.entry.individualId),
  );

  const count = canonical.length;
  const dominationCount = new Int32Array(count);
  const dominatedSets: number[][] = Array.from({ length: count }, () => []);

  for (let p = 0; p < count; p++) {
    const candP = canonical[p]!.entry.metrics;
    for (let q = p + 1; q < count; q++) {
      const candQ = canonical[q]!.entry.metrics;
      if (dominatesObjectives(candP, candQ, objectives)) {
        dominatedSets[p]!.push(q);
        dominationCount[q] = dominationCount[q]! + 1;
      } else if (dominatesObjectives(candQ, candP, objectives)) {
        dominatedSets[q]!.push(p);
        dominationCount[p] = dominationCount[p]! + 1;
      }
    }
  }

  const fronts: number[][] = [];
  let currentFront: number[] = [];
  for (let i = 0; i < count; i++) {
    if (dominationCount[i] === 0) currentFront.push(i);
  }

  while (currentFront.length > 0) {
    fronts.push(currentFront);
    const nextFront: number[] = [];
    for (const p of currentFront) {
      for (const q of dominatedSets[p]!) {
        const nextDom = dominationCount[q]! - 1;
        dominationCount[q] = nextDom;
        if (nextDom === 0) nextFront.push(q);
      }
    }
    currentFront = nextFront;
  }

  const results: RankedParetoEntry[] = [];
  for (let frontIdx = 0; frontIdx < fronts.length; frontIdx++) {
    const front = fronts[frontIdx]!;
    const paretoRank = frontIdx + 1;
    const distances = new Map<number, number>();

    if (front.length <= 2) {
      for (const idx of front) {
        distances.set(idx, Number.POSITIVE_INFINITY);
      }
    } else {
      for (const idx of front) {
        distances.set(idx, 0);
      }
      for (let m = 0; m < objectives.length; m++) {
        const sortedByObj = [...front].sort((idxA, idxB) => {
          const itemA = canonical[idxA]!;
          const itemB = canonical[idxB]!;
          const valA = itemA.normVec[m]!;
          const valB = itemB.normVec[m]!;
          if (valA !== valB) return valA < valB ? -1 : 1;
          return compareLexicographicVectors(
            itemA.normVec,
            itemA.entry.individualId,
            itemB.normVec,
            itemB.entry.individualId,
          );
        });

        const minVal = canonical[sortedByObj[0]!]!.normVec[m]!;
        const maxVal = canonical[sortedByObj[sortedByObj.length - 1]!]!.normVec[m]!;
        const span = maxVal - minVal;
        if (span <= 0) continue;

        distances.set(sortedByObj[0]!, Number.POSITIVE_INFINITY);
        distances.set(sortedByObj[sortedByObj.length - 1]!, Number.POSITIVE_INFINITY);
        for (let pos = 1; pos < sortedByObj.length - 1; pos++) {
          const curIdx = sortedByObj[pos]!;
          const prevDistance = distances.get(curIdx)!;
          if (!Number.isFinite(prevDistance)) continue;
          const prevVal = canonical[sortedByObj[pos - 1]!]!.normVec[m]!;
          const nextVal = canonical[sortedByObj[pos + 1]!]!.normVec[m]!;
          distances.set(curIdx, prevDistance + (nextVal - prevVal) / span);
        }
      }
    }

    const frontRanked = front.map(idx => {
      const item = canonical[idx]!;
      const rawDist = distances.get(idx) ?? 0;
      const crowdingDistance = Object.is(rawDist, -0) ? 0 : rawDist;
      return {
        item,
        ranked: Object.freeze({
          individualId: item.entry.individualId,
          metrics: item.entry.metrics,
          paretoRank,
          crowdingDistance,
        }),
      };
    });

    frontRanked.sort((a, b) => {
      const dA = a.ranked.crowdingDistance;
      const dB = b.ranked.crowdingDistance;
      if (dA !== dB) return dB > dA ? 1 : -1;
      return compareLexicographicVectors(
        a.item.normVec,
        a.ranked.individualId,
        b.item.normVec,
        b.ranked.individualId,
      );
    });

    for (const r of frontRanked) {
      results.push(r.ranked);
    }
  }

  return Object.freeze(results);
}

// ---------------------------------------------------------------------------
// Exact deterministic reference-point Hypervolume (1D / 2D / 3D / d-D HSO sweep)
// ---------------------------------------------------------------------------

function boxDominatesOrEquals(a: readonly number[], b: readonly number[], dims: number): boolean {
  for (let i = 0; i < dims; i++) {
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

function compareBoxLexDesc(a: readonly number[], b: readonly number[], dims: number): number {
  for (let i = 0; i < dims; i++) {
    if (a[i]! !== b[i]!) return b[i]! - a[i]!;
  }
  return 0;
}

function filterNonDominatedBoxes(boxes: readonly (readonly number[])[], dims: number): (readonly number[])[] {
  if (boxes.length <= 1) return [...boxes];
  const sorted = [...boxes].sort((a, b) => compareBoxLexDesc(a, b, dims));
  const kept: (readonly number[])[] = [];
  for (const cand of sorted) {
    let dominated = false;
    for (const existing of kept) {
      if (boxDominatesOrEquals(existing, cand, dims)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push(cand);
  }
  return kept;
}

function computeOriginAnchoredBoxUnionVolume(
  rawBoxes: readonly (readonly number[])[],
  dims: number,
): number {
  if (rawBoxes.length === 0) return 0;
  if (dims === 1) {
    let maxLen = 0;
    for (const box of rawBoxes) {
      if (box[0]! > maxLen) maxLen = box[0]!;
    }
    return maxLen;
  }

  const boxes = filterNonDominatedBoxes(rawBoxes, dims);
  if (dims === 2) {
    // Sorted by dim 0 descending -> non-dominated 2D boxes have strictly increasing dim 1.
    let volume = 0;
    let coveredDim1 = 0;
    for (const box of boxes) {
      const l0 = box[0]!;
      const l1 = box[1]!;
      if (l1 > coveredDim1) {
        volume += l0 * (l1 - coveredDim1);
        coveredDim1 = l1;
      }
    }
    return volume;
  }

  // Exact dimension-sweep along coordinate `lastDim = dims - 1` descending.
  const lastDim = dims - 1;
  const byHeightDesc = [...boxes].sort((a, b) => {
    if (a[lastDim]! !== b[lastDim]!) return b[lastDim]! - a[lastDim]!;
    return compareBoxLexDesc(a, b, lastDim);
  });

  let totalVolume = 0;
  const activeProjected: (readonly number[])[] = [];
  for (let i = 0; i < byHeightDesc.length; i++) {
    const current = byHeightDesc[i]!;
    activeProjected.push(current);
    const currentHeight = current[lastDim]!;
    const nextHeight = i + 1 < byHeightDesc.length ? byHeightDesc[i + 1]![lastDim]! : 0;
    const sliceThickness = currentHeight - nextHeight;
    if (sliceThickness > 0) {
      const sliceMeasure = computeOriginAnchoredBoxUnionVolume(activeProjected, lastDim);
      totalVolume += sliceThickness * sliceMeasure;
    }
  }
  return totalVolume;
}

/**
 * Compute exact deterministic bounded hypervolume of `points` strictly dominating `referencePoint`
 * across `objectives` (`1..8` objectives, Monte-Carlo-free).
 */
export function computeHypervolume(
  points: readonly Readonly<Record<string, number>>[],
  objectives: readonly ObjectiveDirectionSpec[],
  referencePoint: Readonly<Record<string, number>>,
): number {
  if (objectives.length === 0 || objectives.length > 8) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'objectives length must be within 1..8');
  }
  const refCoords: number[] = [];
  for (const obj of objectives) {
    const r = getOwnFiniteMetric(referencePoint, obj.metric);
    if (r === undefined) {
      throw new EvolutionError(
        'EVOLUTION_SCHEMA_INVALID',
        `referencePoint missing finite coordinate for "${obj.metric}"`,
      );
    }
    refCoords.push(r);
  }

  if (points.length === 0) return 0;

  const boxes: (readonly number[])[] = [];
  for (const pt of points) {
    const lengths: number[] = [];
    let strictlyDominatesRef = true;
    for (let m = 0; m < objectives.length; m++) {
      const obj = objectives[m]!;
      const val = getOwnFiniteMetric(pt, obj.metric);
      if (val === undefined) {
        strictlyDominatesRef = false;
        break;
      }
      const refVal = refCoords[m]!;
      const len = obj.direction === 'minimize' ? refVal - val : val - refVal;
      if (len <= 0) {
        strictlyDominatesRef = false;
        break;
      }
      lengths.push(len);
    }
    if (strictlyDominatesRef) {
      boxes.push(lengths);
    }
  }

  const hv = computeOriginAnchoredBoxUnionVolume(boxes, objectives.length);
  return Object.is(hv, -0) ? 0 : hv;
}

/** Compute exact deterministic hypervolume delta `HV(nextPoints) - HV(previousPoints)`. */
export function computeHypervolumeDelta(
  previousPoints: readonly Readonly<Record<string, number>>[],
  nextPoints: readonly Readonly<Record<string, number>>[],
  objectives: readonly ObjectiveDirectionSpec[],
  referencePoint: Readonly<Record<string, number>>,
): number {
  const prevHv = computeHypervolume(previousPoints, objectives, referencePoint);
  const nextHv = computeHypervolume(nextPoints, objectives, referencePoint);
  const delta = nextHv - prevHv;
  return Object.is(delta, -0) ? 0 : delta;
}

// ---------------------------------------------------------------------------
// Deterministic MAP-Elites Niche Key & Fitness Scalarization
// ---------------------------------------------------------------------------

const DIAGNOSTIC_FIELD_ALIASES: Readonly<Record<string, keyof HardwareDiagnostics>> = Object.freeze({
  bound_pipeline: 'boundPipeline',
  boundPipeline: 'boundPipeline',
  roofline_headroom: 'rooflineHeadroom',
  rooflineHeadroom: 'rooflineHeadroom',
  achieved_sol_pct: 'achievedSolPct',
  achievedSolPct: 'achievedSolPct',
  arithmetic_intensity: 'arithmeticIntensity',
  arithmeticIntensity: 'arithmeticIntensity',
  occupancy_band: 'occupancyPct',
  occupancy_pct: 'occupancyPct',
  occupancyPct: 'occupancyPct',
  register_count: 'registerCount',
  registerCount: 'registerCount',
  shared_mem_bytes: 'sharedMemBytes',
  sharedMemBytes: 'sharedMemBytes',
  local_spill_bytes: 'localSpillBytes',
  localSpillBytes: 'localSpillBytes',
  l2_hit_pct: 'l2HitPct',
  l2HitPct: 'l2HitPct',
  bank_conflict_pct: 'bankConflictPct',
  bankConflictPct: 'bankConflictPct',
});

function lookupDiagnosticField(
  diagnostics: HardwareDiagnostics | undefined,
  key: string,
): string | number | undefined {
  if (!diagnostics) return undefined;
  const mappedKey = Object.hasOwn(DIAGNOSTIC_FIELD_ALIASES, key)
    ? DIAGNOSTIC_FIELD_ALIASES[key]
    : undefined;
  if (mappedKey !== undefined && Object.hasOwn(diagnostics, mappedKey)) {
    const val = diagnostics[mappedKey];
    if (typeof val === 'string' || typeof val === 'number') return val;
  }
  return undefined;
}

function formatEdgeNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value);
}

/**
 * Map `metrics` and optional `hardwareDiagnostics` onto a canonical MAP-Elites `nicheKey`
 * across `1..4` declared `enum` or `numeric_bins` axes.
 */
export function computeNicheKey(
  nicheAxes: readonly EvolutionNicheAxis[],
  metrics: Readonly<Record<string, MetricValue>>,
  hardwareDiagnostics?: HardwareDiagnostics,
): string {
  if (nicheAxes.length < 1 || nicheAxes.length > 4) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'nicheAxes length must be within 1..4');
  }

  const tokens: string[] = [];
  for (const axis of nicheAxes) {
    const targetField = axis.field ?? axis.id;
    if (axis.kind === 'enum') {
      let observed: string | undefined;
      if (Object.hasOwn(metrics, targetField) && typeof metrics[targetField] === 'string') {
        observed = metrics[targetField] as string;
      } else {
        const diagVal = lookupDiagnosticField(hardwareDiagnostics, targetField);
        if (typeof diagVal === 'string') observed = diagVal;
      }
      if (observed !== undefined && axis.values.includes(observed)) {
        tokens.push(`${axis.id}=${observed}`);
      } else {
        tokens.push(`${axis.id}=~unclassified`);
      }
    } else {
      const edges = axis.edges;
      if (edges.length < 2) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `numeric_bins axis "${axis.id}" requires >= 2 edges`);
      }
      let numericVal: number | undefined;
      if (Object.hasOwn(metrics, targetField) && typeof metrics[targetField] === 'number') {
        const mVal = metrics[targetField] as number;
        if (Number.isFinite(mVal)) numericVal = mVal;
      }
      if (numericVal === undefined) {
        const diagVal = lookupDiagnosticField(hardwareDiagnostics, targetField);
        if (typeof diagVal === 'number' && Number.isFinite(diagVal)) numericVal = diagVal;
      }

      if (numericVal === undefined) {
        tokens.push(`${axis.id}=~missing`);
        continue;
      }
      const firstEdge = edges[0]!;
      const lastEdge = edges[edges.length - 1]!;
      if (numericVal < firstEdge) {
        tokens.push(`${axis.id}=<-inf,${formatEdgeNumber(firstEdge)})`);
      } else if (numericVal > lastEdge) {
        tokens.push(`${axis.id}=(${formatEdgeNumber(lastEdge)},+inf)`);
      } else {
        let placed = false;
        for (let i = 0; i < edges.length - 1; i++) {
          const low = edges[i]!;
          const high = edges[i + 1]!;
          const isLastBin = i === edges.length - 2;
          if (numericVal >= low && (isLastBin ? numericVal <= high : numericVal < high)) {
            const closeBracket = isLastBin ? ']' : ')';
            tokens.push(`${axis.id}=[${formatEdgeNumber(low)},${formatEdgeNumber(high)}${closeBracket}`);
            placed = true;
            break;
          }
        }
        if (!placed) {
          tokens.push(`${axis.id}=~missing`);
        }
      }
    }
  }

  return tokens.join('|');
}

/** Build `[min, max]` normalization reference statistics across observed metric records. */
export function computeObjectiveReferenceStats(
  entries: readonly Readonly<Record<string, number>>[],
  objectives: readonly ObjectiveDirectionSpec[],
): ObjectiveReferenceStats {
  const out = Object.create(null) as Record<string, ObjectiveMetricStats>;
  for (const obj of objectives) {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const entry of entries) {
      const val = getOwnFiniteMetric(entry, obj.metric);
      if (val === undefined) continue;
      if (val < min) min = val;
      if (val > max) max = val;
    }
    if (Number.isFinite(min) && Number.isFinite(max)) {
      const stat = Object.create(null) as { min: number; max: number };
      stat.min = min;
      stat.max = max;
      out[obj.metric] = stat;
    }
  }
  return out;
}

/**
 * Compute higher-is-better scalar fitness over `objectives` for island median fitness
 * and stepping-stone weight calculation.
 */
export function scalarizeFitness(
  metrics: Readonly<Record<string, number>>,
  objectives: readonly ObjectiveDirectionSpec[],
  referenceStats?: ObjectiveReferenceStats,
): number {
  if (objectives.length === 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'objectives must contain at least 1 entry');
  }
  let weightedSum = 0;
  let totalWeight = 0;
  for (const obj of objectives) {
    const val = getOwnFiniteMetric(metrics, obj.metric);
    if (val === undefined) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `metrics missing finite value for "${obj.metric}"`);
    }
    const stat = referenceStats && Object.hasOwn(referenceStats, obj.metric)
      ? referenceStats[obj.metric]
      : undefined;
    const weight = stat?.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `objective weight for "${obj.metric}" must be > 0`);
    }
    let score: number;
    if (stat !== undefined) {
      const span = stat.max - stat.min;
      if (span <= 0) {
        score = 0.5;
      } else if (obj.direction === 'minimize') {
        score = (stat.max - val) / span;
      } else {
        score = (val - stat.min) / span;
      }
    } else {
      score = obj.direction === 'minimize' ? -val : val;
    }
    weightedSum += weight * score;
    totalWeight += weight;
  }
  const result = weightedSum / totalWeight;
  return Object.is(result, -0) ? 0 : result;
}

/** Compute deterministic median over finite scalar fitness values (`0` when empty). */
export function computeMedianFitness(fitnessValues: readonly number[]): number {
  if (fitnessValues.length === 0) return 0;
  const sorted: number[] = [];
  for (const v of fitnessValues) {
    if (!Number.isFinite(v)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'fitness value must be finite');
    }
    sorted.push(Object.is(v, -0) ? 0 : v);
  }
  sorted.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Object.is(median, -0) ? 0 : median;
}
