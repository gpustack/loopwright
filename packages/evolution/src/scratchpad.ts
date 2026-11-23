import { SecretScrubber } from '@loopwright/core';
import type { EvolutionCampaignStore } from './store.js';
import {
  EvolutionError,
  SCRATCHPAD_MAX_BYTES,
  type CampaignLease,
  type IndividualRecord,
  type ObjectiveDirectionSpec,
  type ScratchpadSnapshotRecord,
} from './types.js';

const DEFAULT_SECRET_SCRUBBER = new SecretScrubber();

export interface ScratchpadNicheGainEntry {
  readonly nicheKey: string;
  readonly childIndividualId: string;
  readonly parentIndividualId: string;
  readonly primaryMetric: string;
  readonly speedupRatio: number;
  readonly relativeDeltaPct: number;
  readonly pipelineShift: string;
}

export interface ScratchpadFailurePatternEntry {
  readonly patternKey: string;
  readonly count: number;
  readonly sampleDetail: string;
}

export interface SynthesizeCampaignScratchpadOptions {
  readonly store: EvolutionCampaignStore;
  readonly lease: CampaignLease;
  readonly campaignId: string;
  readonly generation: number;
  readonly snapshotId?: string;
  readonly maxBytes?: number;
  readonly scrubber?: SecretScrubber;
}

export interface SynthesizedCampaignScratchpad {
  readonly snapshot: ScratchpadSnapshotRecord;
  readonly content: string;
  readonly casFilePath: string;
  readonly topGains: readonly ScratchpadNicheGainEntry[];
  readonly failurePatterns: readonly ScratchpadFailurePatternEntry[];
}

function sanitizeSingleLine(raw: string, maxChars: number, scrubber: SecretScrubber): string {
  const scrubbed = scrubber.scrub(raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (scrubbed.length <= maxChars) return scrubbed;
  return `${scrubbed.slice(0, Math.max(0, maxChars - 3))}...`;
}

function computePrimaryObjectiveGain(
  child: IndividualRecord,
  parent: IndividualRecord,
  objective: ObjectiveDirectionSpec,
): { readonly speedupRatio: number; readonly relativeDeltaPct: number } | null {
  if (!Object.hasOwn(child.metrics, objective.metric) || !Object.hasOwn(parent.metrics, objective.metric)) {
    return null;
  }
  const cVal = child.metrics[objective.metric];
  const pVal = parent.metrics[objective.metric];
  if (cVal === undefined || pVal === undefined || !Number.isFinite(cVal) || !Number.isFinite(pVal)) {
    return null;
  }

  if (objective.direction === 'minimize') {
    if (cVal >= pVal) return null;
    if (cVal > 0 && pVal > 0) {
      return {
        speedupRatio: pVal / cVal,
        relativeDeltaPct: ((cVal - pVal) / pVal) * 100,
      };
    }
    const diff = pVal - cVal;
    return {
      speedupRatio: 1 + diff,
      relativeDeltaPct: pVal !== 0 ? ((cVal - pVal) / Math.abs(pVal)) * 100 : -100,
    };
  }

  if (cVal <= pVal) return null;
  if (pVal > 0) {
    return {
      speedupRatio: cVal / pVal,
      relativeDeltaPct: ((cVal - pVal) / pVal) * 100,
    };
  }
  return {
    speedupRatio: 1 + (cVal - pVal),
    relativeDeltaPct: 100,
  };
}

function classifyFailurePatternKey(
  ind: IndividualRecord,
  parent: IndividualRecord | undefined,
): string {
  if (ind.status === 'failed') {
    const baseReason = ind.failureReason ?? 'UNKNOWN_FAILURE';
    const joinedFindings = (ind.findings ?? [])
      .map(f => `${f.title} ${f.evidence}`.toLowerCase())
      .join(' ');
    if (baseReason === 'STAGE_A_STATIC_AUDIT_FAILED') {
      return 'STAGE_A_STATIC_AUDIT_FAILED';
    }
    if (
      (Object.hasOwn(ind.metrics, 'max_ulp') && (ind.metrics['max_ulp'] ?? 0) > 0)
      || joinedFindings.includes('ulp')
    ) {
      return `${baseReason}:ULP_DRIFT`;
    }
    if (
      Object.hasOwn(ind.metrics, 'token_force_max_delta')
      || joinedFindings.includes('token_force')
    ) {
      return `${baseReason}:TOKEN_FORCE_DRIFT`;
    }
    if (joinedFindings.includes('spill')) {
      return `${baseReason}:SPILL_REGRESSION`;
    }
    return baseReason;
  }

  const childSpill = ind.hardwareDiagnostics?.localSpillBytes;
  const parentSpill = parent?.hardwareDiagnostics?.localSpillBytes ?? 0;
  if (childSpill !== undefined && childSpill > parentSpill) {
    return 'SPILL_REGRESSION';
  }
  return 'OBJECTIVE_REGRESSION';
}

function renderScratchpadMarkdown(
  campaignId: string,
  campaignName: string,
  generation: number,
  gains: readonly ScratchpadNicheGainEntry[],
  patterns: readonly ScratchpadFailurePatternEntry[],
  maxGains: number,
  maxPatterns: number,
): string {
  const lines: string[] = [
    `# Campaign Scratchpad: ${campaignName}`,
    '',
    `- Campaign ID: \`${campaignId}\``,
    `- Generation: ${generation}`,
    '',
    '## Top Niche Gains',
  ];

  const slicedGains = gains.slice(0, maxGains);
  if (slicedGains.length === 0) {
    lines.push('- None recorded yet.');
  } else {
    for (const g of slicedGains) {
      const sign = g.relativeDeltaPct >= 0 ? '+' : '';
      lines.push(
        `- Niche \`${g.nicheKey}\`: \`${g.parentIndividualId}\` -> \`${g.childIndividualId}\` | `
        + `\`${g.primaryMetric}\` **${g.speedupRatio.toFixed(2)}x** (${sign}${g.relativeDeltaPct.toFixed(1)}%) | `
        + `pipeline \`${g.pipelineShift}\``,
      );
    }
  }

  lines.push('', '## Recurring Failure and Regression Patterns');
  const slicedPatterns = patterns.slice(0, maxPatterns);
  if (slicedPatterns.length === 0) {
    lines.push('- None recorded yet.');
  } else {
    for (const p of slicedPatterns) {
      lines.push(`- \`${p.patternKey}\` (${p.count}x): ${p.sampleDetail}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Deterministically synthesize a `<= 16,384`-byte, `SecretScrubber`-clean campaign scratchpad
 * from verified `campaign.sqlite` lineage deltas, persist to CAS (`0o400`, `O_NOFOLLOW`),
 * and record metadata in `scratchpad_snapshots`.
 */
export async function synthesizeCampaignScratchpad(
  options: SynthesizeCampaignScratchpadOptions,
): Promise<SynthesizedCampaignScratchpad> {
  const maxBytes = options.maxBytes ?? SCRATCHPAD_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 512 || maxBytes > SCRATCHPAD_MAX_BYTES) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `maxBytes must be within 512..${SCRATCHPAD_MAX_BYTES}`);
  }
  if (!Number.isSafeInteger(options.generation) || options.generation < 0) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'generation must be an integer >= 0');
  }

  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;
  const campaign = await options.store.getCampaign(options.campaignId);
  if (!campaign) {
    throw new EvolutionError('EVOLUTION_NOT_FOUND', `campaign "${options.campaignId}" not found`);
  }

  const individuals = await options.store.listIndividuals(options.campaignId);
  const lineageEdges = await options.store.listLineageEdges(options.campaignId, { role: 'primary' });

  const byId = new Map<string, IndividualRecord>();
  for (const ind of individuals) {
    byId.set(ind.individualId, ind);
  }

  const primaryParentByChild = new Map<string, IndividualRecord>();
  for (const edge of lineageEdges) {
    const parent = byId.get(edge.parentIndividualId);
    if (parent && !primaryParentByChild.has(edge.childIndividualId)) {
      primaryParentByChild.set(edge.childIndividualId, parent);
    }
  }

  const primaryObjective = campaign.manifest.spec.objectives[0]!;
  const bestGainByNiche = new Map<string, ScratchpadNicheGainEntry>();
  const patternBuckets = new Map<string, { count: number; sampleDetail: string }>();

  const recordPattern = (key: string, rawDetail: string): void => {
    const safeKey = sanitizeSingleLine(key, 96, scrubber);
    const safeDetail = sanitizeSingleLine(rawDetail, 160, scrubber);
    const existing = patternBuckets.get(safeKey);
    if (!existing) {
      patternBuckets.set(safeKey, { count: 1, sampleDetail: safeDetail });
    } else {
      existing.count += 1;
    }
  };

  for (const ind of individuals) {
    if (ind.status === 'preempted') continue;
    const parent = primaryParentByChild.get(ind.individualId);

    if (ind.status === 'failed') {
      const patternKey = classifyFailurePatternKey(ind, parent);
      const firstFinding = ind.findings?.[0];
      const detail = firstFinding
        ? `${firstFinding.title} - ${firstFinding.evidence}`
        : (ind.failureReason ?? 'candidate verification failed');
      recordPattern(patternKey, detail);
      continue;
    }

    if (!parent) continue;
    const gain = computePrimaryObjectiveGain(ind, parent, primaryObjective);
    if (gain !== null) {
      const nicheKey = sanitizeSingleLine(ind.nicheKey ?? 'unclassified', 120, scrubber);
      const parentPipe = parent.hardwareDiagnostics?.boundPipeline ?? 'unknown';
      const childPipe = ind.hardwareDiagnostics?.boundPipeline ?? 'unknown';
      const entry: ScratchpadNicheGainEntry = Object.freeze({
        nicheKey,
        childIndividualId: ind.individualId,
        parentIndividualId: parent.individualId,
        primaryMetric: primaryObjective.metric,
        speedupRatio: gain.speedupRatio,
        relativeDeltaPct: gain.relativeDeltaPct,
        pipelineShift: `${parentPipe} -> ${childPipe}`,
      });
      const incumbent = bestGainByNiche.get(nicheKey);
      if (
        !incumbent
        || entry.speedupRatio > incumbent.speedupRatio
        || (entry.speedupRatio === incumbent.speedupRatio && entry.childIndividualId < incumbent.childIndividualId)
      ) {
        bestGainByNiche.set(nicheKey, entry);
      }
    } else if (
      ind.hardwareDiagnostics?.localSpillBytes !== undefined
      && ind.hardwareDiagnostics.localSpillBytes > (parent.hardwareDiagnostics?.localSpillBytes ?? 0)
    ) {
      recordPattern(
        'SPILL_REGRESSION',
        `localSpillBytes increased ${parent.hardwareDiagnostics?.localSpillBytes ?? 0} -> ${ind.hardwareDiagnostics.localSpillBytes} in ${ind.individualId}`,
      );
    }
  }

  const topGains = [...bestGainByNiche.values()].sort((a, b) => {
    if (b.speedupRatio !== a.speedupRatio) return b.speedupRatio - a.speedupRatio;
    if (a.nicheKey !== b.nicheKey) return a.nicheKey < b.nicheKey ? -1 : 1;
    return a.childIndividualId < b.childIndividualId ? -1 : a.childIndividualId > b.childIndividualId ? 1 : 0;
  });

  const failurePatterns: ScratchpadFailurePatternEntry[] = [...patternBuckets.entries()]
    .map(([patternKey, info]) =>
      Object.freeze({
        patternKey,
        count: info.count,
        sampleDetail: info.sampleDetail,
      }),
    )
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.patternKey < b.patternKey ? -1 : a.patternKey > b.patternKey ? 1 : 0;
    });

  const safeName = sanitizeSingleLine(campaign.name, 64, scrubber);
  const safeCampaignId = sanitizeSingleLine(campaign.campaignId, 64, scrubber);

  let maxGains = Math.min(topGains.length, 32);
  let maxPatterns = Math.min(failurePatterns.length, 32);
  let rendered = scrubber.scrub(
    renderScratchpadMarkdown(safeCampaignId, safeName, options.generation, topGains, failurePatterns, maxGains, maxPatterns),
  );

  while (Buffer.byteLength(rendered, 'utf8') > maxBytes && (maxGains > 0 || maxPatterns > 0)) {
    if (maxGains >= maxPatterns && maxGains > 0) {
      maxGains--;
    } else if (maxPatterns > 0) {
      maxPatterns--;
    } else {
      break;
    }
    rendered = scrubber.scrub(
      renderScratchpadMarkdown(safeCampaignId, safeName, options.generation, topGains, failurePatterns, maxGains, maxPatterns),
    );
  }

  if (Buffer.byteLength(rendered, 'utf8') > maxBytes) {
    const buf = Buffer.from(rendered, 'utf8');
    let end = maxBytes - 1;
    while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
    rendered = `${scrubber.scrub(buf.subarray(0, end).toString('utf8'))}\n`;
  }

  if (scrubber.containsSecret(rendered)) {
    throw new EvolutionError('SECRET_LEAK_DETECTED', 'scratchpad synthesis output failed SecretScrubber check');
  }

  const casBlob = await options.store.writeCasBlob(rendered);
  const snapshotId = options.snapshotId ?? `${options.campaignId}-gen${options.generation}-${casBlob.digest.hex.slice(0, 12)}`;
  const snapshot = await options.store.recordScratchpadSnapshot(options.lease, {
    snapshotId,
    campaignId: options.campaignId,
    generation: options.generation,
    casDigest: casBlob.digest,
    byteLength: casBlob.byteLength,
    casRelPath: casBlob.casRelPath,
    topGainsCount: maxGains,
    failurePatternsCount: maxPatterns,
  });

  return Object.freeze({
    snapshot,
    content: rendered,
    casFilePath: casBlob.casPath,
    topGains: Object.freeze(topGains.slice(0, maxGains)),
    failurePatterns: Object.freeze(failurePatterns.slice(0, maxPatterns)),
  });
}
