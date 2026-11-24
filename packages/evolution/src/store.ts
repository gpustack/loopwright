import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type {
  ArtifactRef,
  BucketMetricEntry,
  Digest,
  HardwareDiagnostics,
  HardwareProvenance,
  StructuredFinding,
} from '@loopwright/core';
import {
  canonicalizeJson,
  parseArtifactRefsJson,
  parseBucketMetricsJson,
  parseEvolutionCampaignDocument,
  parseHardwareDiagnosticsJson,
  parseHardwareProvenanceJson,
  parseMetricsRecordJson,
  parseStructuredFindingsJson,
  parseTeamDiagnosisJson,
  parseTeamDiagnosisValue,
  sanitizeUntrustedValue,
} from './schema.js';
import {
  CAMPAIGN_APPLICATION_ID,
  CAMPAIGN_CLOCK_MAX_DRIFT_MS,
  CAMPAIGN_FORMAT_VERSION,
  EvolutionError,
  type CampaignClockSource,
  type CampaignLease,
  type CampaignMetaRecord,
  type CampaignRecord,
  type CampaignStagePhase,
  type CampaignStatus,
  type EvolutionCampaignManifest,
  type IndividualMutationKind,
  type IndividualRecord,
  type IndividualStatus,
  type IslandRecord,
  type LineageEdgeRecord,
  type LineageRole,
  type ModelBanditArmRecord,
  type ScratchpadSnapshotRecord,
  type TeamConfigRecord,
  type TeamConfigStatus,
  type TeamPatchDiagnosis,
} from './types.js';

export const CAMPAIGN_SQLITE_FILENAME = 'campaign.sqlite' as const;

export const DEFAULT_CAMPAIGN_CLOCK: CampaignClockSource = Object.freeze({
  nowMonotonicMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  },
  nowWallMs(): number {
    return Date.now();
  },
});

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CAMPAIGN_DDL = `
CREATE TABLE IF NOT EXISTS campaign_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  lease_id TEXT,
  fence_epoch INTEGER NOT NULL CHECK (fence_epoch >= 0),
  created_monotonic_ms INTEGER NOT NULL CHECK (created_monotonic_ms >= 0),
  created_wall_ms INTEGER NOT NULL CHECK (created_wall_ms >= 0),
  last_monotonic_ms INTEGER NOT NULL CHECK (last_monotonic_ms >= 0),
  last_wall_ms INTEGER NOT NULL CHECK (last_wall_ms >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS campaigns (
  campaign_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'failed')),
  stage_phase TEXT NOT NULL CHECK (stage_phase IN ('single-target', 'specialist', 'portfolio')),
  active_bucket_id TEXT,
  manifest_json TEXT NOT NULL,
  manifest_digest_hex TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  lock_hash_hex TEXT NOT NULL,
  driver_constraint TEXT,
  current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
  evaluations_used INTEGER NOT NULL CHECK (evaluations_used >= 0),
  preemptions_count INTEGER NOT NULL CHECK (preemptions_count >= 0),
  created_at_wall_ms INTEGER NOT NULL,
  updated_at_wall_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS islands (
  campaign_id TEXT NOT NULL,
  island_id INTEGER NOT NULL CHECK (island_id >= 0 AND island_id < 16),
  active_team_config_id TEXT NOT NULL,
  current_generation INTEGER NOT NULL CHECK (current_generation >= 0),
  consecutive_no_gain_generations INTEGER NOT NULL CHECK (consecutive_no_gain_generations >= 0),
  consecutive_pathology_runs INTEGER NOT NULL CHECK (consecutive_pathology_runs >= 0),
  last_hypervolume REAL NOT NULL CHECK (last_hypervolume >= 0),
  best_roofline_headroom REAL,
  PRIMARY KEY (campaign_id, island_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS team_configs (
  team_config_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  island_id INTEGER NOT NULL CHECK (island_id >= 0 AND island_id < 16),
  parent_team_config_id TEXT,
  created_generation INTEGER NOT NULL CHECK (created_generation >= 0),
  status TEXT NOT NULL CHECK (status IN ('baseline', 'trial', 'promoted', 'rolled_back')),
  trial_budget_generations INTEGER NOT NULL CHECK (trial_budget_generations >= 0),
  trial_used_generations INTEGER NOT NULL CHECK (trial_used_generations >= 0),
  diagnosis_json TEXT,
  patch_cas_digest_hex TEXT,
  pareto_advances INTEGER NOT NULL CHECK (pareto_advances >= 0),
  niche_discoveries INTEGER NOT NULL CHECK (niche_discoveries >= 0),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_team_config_id) REFERENCES team_configs(team_config_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS individuals (
  individual_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  island_id INTEGER NOT NULL CHECK (island_id >= 0 AND island_id < 16),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  bucket_id TEXT,
  team_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  track_id TEXT,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('baseline', 'diff_tune', 'full_rewrite', 'crossover', 'portfolio')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'soft_passed', 'failed', 'preempted')),
  failure_reason TEXT,
  niche_key TEXT,
  pareto_rank INTEGER,
  crowding_distance REAL,
  crowding_is_boundary INTEGER NOT NULL DEFAULT 0 CHECK (crowding_is_boundary IN (0, 1)),
  scalar_fitness REAL,
  offspring_count INTEGER NOT NULL CHECK (offspring_count >= 0),
  code_slice_cas_digest_hex TEXT,
  evidence_digest_hex TEXT,
  verdict_receipt_cas_digest_hex TEXT,
  output_artifacts_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  bucket_metrics_json TEXT,
  hardware_diagnostics_json TEXT,
  hardware_provenance_json TEXT,
  findings_json TEXT,
  created_at_wall_ms INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (team_config_id) REFERENCES team_configs(team_config_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS lineage_edges (
  campaign_id TEXT NOT NULL,
  child_individual_id TEXT NOT NULL,
  parent_individual_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'crossover_donor', 'inspiration', 'portfolio_member')),
  source_island_id INTEGER NOT NULL CHECK (source_island_id >= 0 AND source_island_id < 16),
  created_generation INTEGER NOT NULL CHECK (created_generation >= 0),
  PRIMARY KEY (campaign_id, child_individual_id, parent_individual_id, role),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT,
  FOREIGN KEY (child_individual_id) REFERENCES individuals(individual_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_individual_id) REFERENCES individuals(individual_id) ON DELETE RESTRICT,
  CHECK (child_individual_id <> parent_individual_id)
) STRICT;

CREATE TABLE IF NOT EXISTS model_bandit_arms (
  campaign_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  pull_count INTEGER NOT NULL CHECK (pull_count >= 0),
  total_reward REAL NOT NULL CHECK (total_reward >= 0),
  mean_reward REAL NOT NULL CHECK (mean_reward >= 0),
  last_pulled_generation INTEGER,
  PRIMARY KEY (campaign_id, model_id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS scratchpad_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  cas_digest_hex TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 16384),
  cas_rel_path TEXT NOT NULL,
  top_gains_count INTEGER NOT NULL CHECK (top_gains_count >= 0),
  failure_patterns_count INTEGER NOT NULL CHECK (failure_patterns_count >= 0),
  created_at_wall_ms INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_individuals_campaign_island
  ON individuals(campaign_id, island_id, status);
CREATE INDEX IF NOT EXISTS idx_individuals_niche
  ON individuals(campaign_id, island_id, niche_key);
CREATE INDEX IF NOT EXISTS idx_lineage_child
  ON lineage_edges(campaign_id, child_individual_id);
CREATE INDEX IF NOT EXISTS idx_lineage_parent
  ON lineage_edges(campaign_id, parent_individual_id);
CREATE INDEX IF NOT EXISTS idx_team_configs_island
  ON team_configs(campaign_id, island_id, status);
CREATE INDEX IF NOT EXISTS idx_scratchpads_campaign_gen
  ON scratchpad_snapshots(campaign_id, generation DESC);
`;

type SqlRow = Record<string, SQLOutputValue>;

function createNullRecord<T extends Record<string, unknown>>(): T {
  return Object.create(null) as T;
}

function digestFromHex(hex: string): Digest {
  if (!SHA256_HEX_RE.test(hex)) {
    throw new EvolutionError('EVOLUTION_STORE_CORRUPT', `corrupt sha256 hex "${hex}"`);
  }
  const out = createNullRecord<{ algorithm: 'sha256'; hex: string }>();
  out.algorithm = 'sha256';
  out.hex = hex;
  return out;
}

function assertSafeId(value: string, label: string): void {
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `invalid ${label} "${String(value)}"`, `/${label}`);
  }
}

function assertDigest(digest: Digest, label: string): void {
  if (!digest || digest.algorithm !== 'sha256' || !SHA256_HEX_RE.test(digest.hex)) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `invalid ${label} digest`, `/${label}`);
  }
}

async function ensureNonSymlinkDirectory(dirPath: string, createIfMissing: boolean): Promise<void> {
  const existing = await lstat(dirPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${dirPath}`, dirPath);
    }
    throw err;
  });

  if (existing === null) {
    if (!createIfMissing) {
      throw new EvolutionError('EVOLUTION_NOT_FOUND', `directory does not exist: ${dirPath}`, dirPath);
    }
    await mkdir(dirPath, { mode: 0o700, recursive: false }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
  } else if (existing.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `directory cannot be a symlink: ${dirPath}`, dirPath);
  } else if (!existing.isDirectory()) {
    throw new EvolutionError('EVOLUTION_STORE_ERROR', `expected directory at ${dirPath}`, dirPath);
  }

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const dirFlag = 'O_DIRECTORY' in fsConstants ? fsConstants.O_DIRECTORY : 0;
  const handle = await open(dirPath, fsConstants.O_RDONLY | noFollow | dirFlag).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink directory forbidden: ${dirPath}`, dirPath);
    }
    throw err;
  });
  try {
    const fdStat = await handle.stat();
    if (!fdStat.isDirectory()) {
      throw new EvolutionError('EVOLUTION_STORE_ERROR', `expected directory at ${dirPath}`, dirPath);
    }
  } finally {
    await handle.close();
  }
}

async function prepareSqliteFileNoFollow(dbPath: string, createIfMissing: boolean): Promise<boolean> {
  const journalPath = `${dbPath}-journal`;
  const journalStat = await lstat(journalPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink journal forbidden: ${journalPath}`, journalPath);
    }
    throw err;
  });
  if (journalStat !== null && journalStat.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `journal cannot be a symlink: ${journalPath}`, journalPath);
  }

  const before = await lstat(dbPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${dbPath}`, dbPath);
    }
    throw err;
  });

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  if (before === null) {
    if (!createIfMissing) {
      throw new EvolutionError('EVOLUTION_NOT_FOUND', `campaign.sqlite does not exist at ${dbPath}`, dbPath);
    }
    const handle = await open(
      dbPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | noFollow,
      0o600,
    ).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden at ${dbPath}`, dbPath);
      }
      throw err;
    });
    await handle.close();
    return true;
  }

  if (before.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `campaign.sqlite cannot be a symlink: ${dbPath}`, dbPath);
  }
  if (!before.isFile() || before.nlink !== 1) {
    throw new EvolutionError('EVOLUTION_STORE_CORRUPT', `campaign.sqlite must be a regular unlinked file: ${dbPath}`, dbPath);
  }

  const handle = await open(dbPath, fsConstants.O_RDONLY | noFollow).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden at ${dbPath}`, dbPath);
    }
    throw err;
  });
  try {
    const fdStat = await handle.stat();
    if (!fdStat.isFile() || fdStat.nlink !== 1) {
      throw new EvolutionError('EVOLUTION_STORE_CORRUPT', `campaign.sqlite failed fd stat verification: ${dbPath}`, dbPath);
    }
    return fdStat.size === 0;
  } finally {
    await handle.close();
  }
}

export interface OpenCampaignStoreOptions {
  readonly campaignRoot: string;
  readonly clock?: CampaignClockSource;
  readonly createIfMissing?: boolean;
}

export interface CreateCampaignInput {
  readonly campaignId: string;
  readonly manifest: EvolutionCampaignManifest;
  readonly manifestDigest: Digest;
  readonly baseRevision: string;
  readonly lockHash: Digest;
  readonly driverConstraint?: string | null;
  readonly stagePhase?: CampaignStagePhase;
  readonly activeBucketId?: string | null;
  readonly modelIds?: readonly string[];
}

export interface UpdateCampaignProgressInput {
  readonly campaignId: string;
  readonly status?: CampaignStatus;
  readonly stagePhase?: CampaignStagePhase;
  readonly activeBucketId?: string | null;
  readonly driverConstraint?: string | null;
  readonly currentGeneration?: number;
}

export interface UpdateIslandProgressInput {
  readonly campaignId: string;
  readonly islandId: number;
  readonly activeTeamConfigId?: string;
  readonly currentGeneration?: number;
  readonly consecutiveNoGainGenerations?: number;
  readonly consecutivePathologyRuns?: number;
  readonly lastHypervolume?: number;
  readonly bestRooflineHeadroom?: number | null;
}

export interface CreateTrialTeamConfigInput {
  readonly teamConfigId: string;
  readonly campaignId: string;
  readonly islandId: number;
  readonly parentTeamConfigId: string;
  readonly createdGeneration: number;
  readonly trialBudgetGenerations: number;
  readonly diagnosis: TeamPatchDiagnosis;
  readonly patchCasDigest: Digest;
}

export interface RecordTeamTrialGenerationInput {
  readonly teamConfigId: string;
  readonly advancedPareto: boolean;
  readonly discoveredNiche: boolean;
  readonly preempted?: boolean;
}

export interface RecordIndividualInput {
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
  readonly offspringCount?: number;
  readonly countEvaluation?: boolean;
  readonly codeSliceCasDigest: Digest | null;
  readonly evidenceDigest: Digest | null;
  readonly verdictReceiptCasDigest: Digest | null;
  readonly outputArtifacts: readonly ArtifactRef[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
  readonly hardwareProvenance?: HardwareProvenance;
  readonly findings?: readonly StructuredFinding[];
  readonly lineageEdges?: readonly LineageEdgeRecord[];
}

export interface ListIndividualsFilter {
  readonly islandId?: number;
  readonly status?: readonly IndividualStatus[];
  readonly bucketId?: string | null;
  readonly nicheKey?: string;
}

export interface ParetoRankUpdate {
  readonly individualId: string;
  readonly paretoRank: number | null;
  readonly crowdingDistance: number | null;
  readonly scalarFitness?: number | null;
}

export interface ListLineageEdgesFilter {
  readonly childIndividualId?: string;
  readonly parentIndividualId?: string;
  readonly role?: LineageRole;
}

export interface RecordModelBanditRewardInput {
  readonly campaignId: string;
  readonly modelId: string;
  readonly reward: number;
  readonly generation: number;
}

export interface WrittenCasBlob {
  readonly digest: Digest;
  readonly byteLength: number;
  readonly casPath: string;
  readonly casRelPath: string;
}

export interface RecordScratchpadSnapshotInput {
  readonly snapshotId: string;
  readonly campaignId: string;
  readonly generation: number;
  readonly casDigest: Digest;
  readonly byteLength: number;
  readonly casRelPath: string;
  readonly topGainsCount: number;
  readonly failurePatternsCount: number;
}

export interface CampaignStorePragmasSnapshot {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeout: number;
  readonly tables: readonly string[];
}

/**
 * Single-writer fenced SQLite store for `@loopwright/evolution` (`<campaignRoot>/campaign.sqlite`),
 * completely isolated from per-run `@loopwright/state` `LocalRunStore`.
 */
export class EvolutionCampaignStore {
  readonly campaignRoot: string;
  readonly dbPath: string;
  readonly #db: DatabaseSync;
  readonly #clock: CampaignClockSource;
  readonly #sessionBaseMonoMs: number;
  readonly #sessionBaseWallMs: number;
  readonly #manifestCache = new Map<string, EvolutionCampaignManifest>();
  #reopenedNeedsClockReanchor: boolean;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    campaignRoot: string,
    dbPath: string,
    db: DatabaseSync,
    clock: CampaignClockSource,
    sessionBaseMonoMs: number,
    sessionBaseWallMs: number,
    reopenedFromExisting: boolean,
  ) {
    this.campaignRoot = campaignRoot;
    this.dbPath = dbPath;
    this.#db = db;
    this.#clock = clock;
    this.#sessionBaseMonoMs = sessionBaseMonoMs;
    this.#sessionBaseWallMs = sessionBaseWallMs;
    this.#reopenedNeedsClockReanchor = reopenedFromExisting;
  }

  static async open(options: OpenCampaignStoreOptions): Promise<EvolutionCampaignStore> {
    if (typeof options.campaignRoot !== 'string' || options.campaignRoot.length === 0) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'campaignRoot must be a non-empty path', '/campaignRoot');
    }
    const createIfMissing = options.createIfMissing ?? true;
    const clock = options.clock ?? DEFAULT_CAMPAIGN_CLOCK;
    const campaignRoot = resolve(options.campaignRoot);

    await ensureNonSymlinkDirectory(campaignRoot, createIfMissing);
    if (createIfMissing) {
      await ensureNonSymlinkDirectory(join(campaignRoot, 'cas'), true);
      await ensureNonSymlinkDirectory(join(campaignRoot, 'cas', 'sha256'), true);
    }

    const dbPath = join(campaignRoot, CAMPAIGN_SQLITE_FILENAME);
    const freshFile = await prepareSqliteFileNoFollow(dbPath, createIfMissing);

    const monoNow = clock.nowMonotonicMs();
    const wallNow = clock.nowWallMs();
    if (
      !Number.isSafeInteger(monoNow) || Object.is(monoNow, -0) || monoNow < 0
      || !Number.isSafeInteger(wallNow) || Object.is(wallNow, -0) || wallNow < 0
    ) {
      throw new EvolutionError('EVOLUTION_CLOCK_DRIFT', 'clock source returned non-integer or negative timestamp');
    }

    const db = new DatabaseSync(dbPath, {
      timeout: 250,
      allowExtension: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });

    try {
      db.exec('PRAGMA journal_mode = DELETE;');
      db.exec('PRAGMA synchronous = FULL;');
      db.exec('PRAGMA busy_timeout = 250;');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec('PRAGMA trusted_schema = OFF;');

      const journalRow = db.prepare('PRAGMA journal_mode;').get() as { readonly journal_mode?: unknown } | undefined;
      const syncRow = db.prepare('PRAGMA synchronous;').get() as { readonly synchronous?: unknown } | undefined;
      const fkRow = db.prepare('PRAGMA foreign_keys;').get() as { readonly foreign_keys?: unknown } | undefined;
      if (journalRow?.journal_mode !== 'delete' || syncRow?.synchronous !== 2 || fkRow?.foreign_keys !== 1) {
        throw new EvolutionError('EVOLUTION_STORE_CORRUPT', 'failed to enforce SQLite DELETE/FULL/FK pragmas');
      }

      if (freshFile) {
        db.exec('BEGIN IMMEDIATE;');
        try {
          db.exec(CAMPAIGN_DDL);
          db.exec(`PRAGMA application_id = ${CAMPAIGN_APPLICATION_ID}; PRAGMA user_version = ${CAMPAIGN_FORMAT_VERSION};`);
          db.prepare(
            `INSERT INTO campaign_meta (
              singleton, format_version, lease_id, fence_epoch,
              created_monotonic_ms, created_wall_ms, last_monotonic_ms, last_wall_ms
            ) VALUES (1, ?, NULL, 0, ?, ?, ?, ?);`,
          ).run(CAMPAIGN_FORMAT_VERSION, monoNow, wallNow, monoNow, wallNow);
          db.exec('COMMIT;');
        } catch (err) {
          if (db.isTransaction) db.exec('ROLLBACK;');
          throw err;
        }
      } else {
        const appRow = db.prepare('PRAGMA application_id;').get() as { readonly application_id?: unknown } | undefined;
        const verRow = db.prepare('PRAGMA user_version;').get() as { readonly user_version?: unknown } | undefined;
        if (appRow?.application_id !== CAMPAIGN_APPLICATION_ID || verRow?.user_version !== CAMPAIGN_FORMAT_VERSION) {
          throw new EvolutionError('EVOLUTION_STORE_CORRUPT', 'unexpected campaign.sqlite header version');
        }
        const metaRow = db.prepare('SELECT * FROM campaign_meta WHERE singleton = 1;').get() as SqlRow | undefined;
        if (!metaRow || metaRow['format_version'] !== CAMPAIGN_FORMAT_VERSION) {
          throw new EvolutionError('EVOLUTION_STORE_CORRUPT', 'missing or corrupt campaign_meta row');
        }
        if (monoNow < Number(metaRow['last_monotonic_ms']) || wallNow < Number(metaRow['last_wall_ms'])) {
          throw new EvolutionError('EVOLUTION_CLOCK_DRIFT', 'clock regressed behind persisted campaign_meta timestamp');
        }
        const campaignCols = db.prepare('PRAGMA table_info(campaigns);').all() as SqlRow[];
        if (!campaignCols.some(col => String(col['name']) === 'driver_constraint')) {
          db.exec('BEGIN IMMEDIATE;');
          try {
            db.exec('ALTER TABLE campaigns ADD COLUMN driver_constraint TEXT;');
            db.exec('COMMIT;');
          } catch (err) {
            if (db.isTransaction) db.exec('ROLLBACK;');
            throw err;
          }
        }
      }

      return new EvolutionCampaignStore(campaignRoot, dbPath, db, clock, monoNow, wallNow, !freshFile);
    } catch (err) {
      try {
        db.close();
      } catch {
        // Ignore close error while surfacing open failure.
      }
      if (err instanceof EvolutionError) throw err;
      throw new EvolutionError('EVOLUTION_STORE_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  /** Single-writer in-process async coordinator queue serializing all SQLite reads and writes. */
  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.#queue.then(async () => {
      this.#assertOpen();
      return await operation();
    });
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new EvolutionError('EVOLUTION_STORE_CLOSED', 'campaign store is closed');
    }
  }

  #readMetaSync(): CampaignMetaRecord {
    const row = this.#db.prepare('SELECT * FROM campaign_meta WHERE singleton = 1;').get() as SqlRow | undefined;
    if (!row) {
      throw new EvolutionError('EVOLUTION_STORE_CORRUPT', 'campaign_meta singleton row missing');
    }
    const out = createNullRecord<{
      formatVersion: number;
      leaseId: string | null;
      fenceEpoch: number;
      createdMonotonicMs: number;
      createdWallMs: number;
      lastMonotonicMs: number;
      lastWallMs: number;
    }>();
    out.formatVersion = Number(row['format_version']);
    out.leaseId = row['lease_id'] === null ? null : String(row['lease_id']);
    out.fenceEpoch = Number(row['fence_epoch']);
    out.createdMonotonicMs = Number(row['created_monotonic_ms']);
    out.createdWallMs = Number(row['created_wall_ms']);
    out.lastMonotonicMs = Number(row['last_monotonic_ms']);
    out.lastWallMs = Number(row['last_wall_ms']);
    return out;
  }

  #sampleAndVerifyClockSync(
    meta: CampaignMetaRecord,
    allowSessionReanchor = false,
  ): { readonly monoMs: number; readonly wallMs: number } {
    const monoMs = this.#clock.nowMonotonicMs();
    const wallMs = this.#clock.nowWallMs();
    if (
      !Number.isSafeInteger(monoMs) || Object.is(monoMs, -0) || monoMs < 0
      || !Number.isSafeInteger(wallMs) || Object.is(wallMs, -0) || wallMs < 0
    ) {
      throw new EvolutionError('EVOLUTION_CLOCK_DRIFT', 'clock returned invalid sample');
    }
    if (monoMs < meta.lastMonotonicMs || wallMs < meta.lastWallMs) {
      throw new EvolutionError('EVOLUTION_CLOCK_DRIFT', 'clock regressed behind last committed campaign timestamp');
    }
    const sessionDrift = Math.abs((wallMs - this.#sessionBaseWallMs) - (monoMs - this.#sessionBaseMonoMs));
    if (sessionDrift > CAMPAIGN_CLOCK_MAX_DRIFT_MS) {
      throw new EvolutionError(
        'EVOLUTION_CLOCK_DRIFT',
        `cumulative session clock drift ${sessionDrift}ms exceeds ${CAMPAIGN_CLOCK_MAX_DRIFT_MS}ms guard`,
      );
    }
    if (!allowSessionReanchor) {
      const stepDrift = Math.abs((wallMs - meta.lastWallMs) - (monoMs - meta.lastMonotonicMs));
      if (stepDrift > CAMPAIGN_CLOCK_MAX_DRIFT_MS) {
        throw new EvolutionError(
          'EVOLUTION_CLOCK_DRIFT',
          `clock drift ${stepDrift}ms exceeds ${CAMPAIGN_CLOCK_MAX_DRIFT_MS}ms guard`,
        );
      }
    }
    return { monoMs, wallMs };
  }

  #assertLeaseAndTickClockSync(lease: CampaignLease): { readonly monoMs: number; readonly wallMs: number } {
    if (
      !lease
      || typeof lease.leaseId !== 'string'
      || lease.leaseId.length === 0
      || !Number.isSafeInteger(lease.fenceEpoch)
      || lease.fenceEpoch < 1
    ) {
      throw new EvolutionError('EVOLUTION_LEASE_FENCED', 'invalid lease credentials');
    }
    const meta = this.#readMetaSync();
    if (meta.leaseId === null || meta.leaseId !== lease.leaseId || meta.fenceEpoch !== lease.fenceEpoch) {
      throw new EvolutionError(
        'EVOLUTION_LEASE_FENCED',
        `stale campaign lease (expected epoch ${meta.fenceEpoch}, got ${lease.fenceEpoch})`,
      );
    }
    const now = this.#sampleAndVerifyClockSync(meta);
    this.#db
      .prepare('UPDATE campaign_meta SET last_monotonic_ms = ?, last_wall_ms = ? WHERE singleton = 1;')
      .run(now.monoMs, now.wallMs);
    return now;
  }

  #inWriteTransaction<T>(lease: CampaignLease, fn: (now: { readonly monoMs: number; readonly wallMs: number }) => T): T {
    this.#db.exec('BEGIN IMMEDIATE;');
    try {
      const now = this.#assertLeaseAndTickClockSync(lease);
      const res = fn(now);
      this.#db.exec('COMMIT;');
      return res;
    } catch (err) {
      if (this.#db.isTransaction) {
        this.#db.exec('ROLLBACK;');
      }
      if (err instanceof EvolutionError) throw err;
      const errCode = err !== null && typeof err === 'object' && 'errcode' in err && typeof err.errcode === 'number'
        ? err.errcode & 255
        : 0;
      if (errCode === 5 || errCode === 6) {
        throw new EvolutionError('EVOLUTION_STORE_BUSY', err instanceof Error ? err.message : String(err));
      }
      throw new EvolutionError('EVOLUTION_STORE_ERROR', err instanceof Error ? err.message : String(err));
    }
  }

  inspectPragmas(): Promise<CampaignStorePragmasSnapshot> {
    return this.enqueue(() => {
      const journal = this.#db.prepare('PRAGMA journal_mode;').get() as { readonly journal_mode?: unknown } | undefined;
      const sync = this.#db.prepare('PRAGMA synchronous;').get() as { readonly synchronous?: unknown } | undefined;
      const fk = this.#db.prepare('PRAGMA foreign_keys;').get() as { readonly foreign_keys?: unknown } | undefined;
      const busy = this.#db.prepare('PRAGMA busy_timeout;').get() as { readonly timeout?: unknown } | undefined;
      const tableRows = this.#db
        .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC;")
        .all() as SqlRow[];
      for (const row of tableRows) {
        if (row['strict'] !== 1) {
          throw new EvolutionError('EVOLUTION_STORE_CORRUPT', `table ${String(row['name'])} is not STRICT`);
        }
      }
      return Object.freeze({
        journalMode: String(journal?.journal_mode ?? ''),
        synchronous: Number(sync?.synchronous ?? -1),
        foreignKeys: Number(fk?.foreign_keys ?? 0),
        busyTimeout: Number(busy?.timeout ?? 0),
        tables: Object.freeze(tableRows.map(r => String(r['name']))),
      });
    });
  }

  getMeta(): Promise<CampaignMetaRecord> {
    return this.enqueue(() => this.#readMetaSync());
  }

  acquireLease(leaseId?: string): Promise<CampaignLease> {
    return this.enqueue(() => {
      const resolvedLeaseId = leaseId ?? randomUUID();
      assertSafeId(resolvedLeaseId, 'leaseId');
      this.#db.exec('BEGIN IMMEDIATE;');
      try {
        const meta = this.#readMetaSync();
        const now = this.#sampleAndVerifyClockSync(meta, this.#reopenedNeedsClockReanchor);
        this.#reopenedNeedsClockReanchor = false;
        const nextEpoch = meta.fenceEpoch + 1;
        this.#db
          .prepare(
            'UPDATE campaign_meta SET lease_id = ?, fence_epoch = ?, last_monotonic_ms = ?, last_wall_ms = ? WHERE singleton = 1;',
          )
          .run(resolvedLeaseId, nextEpoch, now.monoMs, now.wallMs);
        this.#db.exec('COMMIT;');
        const out = createNullRecord<{ leaseId: string; fenceEpoch: number }>();
        out.leaseId = resolvedLeaseId;
        out.fenceEpoch = nextEpoch;
        return out;
      } catch (err) {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK;');
        if (err instanceof EvolutionError) throw err;
        throw new EvolutionError('EVOLUTION_STORE_ERROR', err instanceof Error ? err.message : String(err));
      }
    });
  }

  releaseLease(lease: CampaignLease): Promise<void> {
    return this.enqueue(() => {
      this.#inWriteTransaction(lease, () => {
        this.#db.prepare('UPDATE campaign_meta SET lease_id = NULL WHERE singleton = 1;').run();
      });
    });
  }

  #parseCachedManifest(campaignId: string, digestHex: string, manifestJson: string): EvolutionCampaignManifest {
    const cacheKey = `${campaignId}:${digestHex}`;
    const cached = this.#manifestCache.get(cacheKey);
    if (cached) return cached;
    const parsed = parseEvolutionCampaignDocument(manifestJson);
    this.#manifestCache.set(cacheKey, parsed);
    return parsed;
  }

  #hydrateCampaignRow(row: SqlRow): CampaignRecord {
    const campaignId = String(row['campaign_id']);
    const manifestDigestHex = String(row['manifest_digest_hex']);
    const manifest = this.#parseCachedManifest(campaignId, manifestDigestHex, String(row['manifest_json']));
    const out = createNullRecord<{
      campaignId: string;
      name: string;
      status: CampaignStatus;
      stagePhase: CampaignStagePhase;
      activeBucketId: string | null;
      manifest: EvolutionCampaignManifest;
      manifestDigest: Digest;
      baseRevision: string;
      lockHash: Digest;
      driverConstraint: string | null;
      currentGeneration: number;
      evaluationsUsed: number;
      preemptionsCount: number;
      createdAtWallMs: number;
      updatedAtWallMs: number;
    }>();
    out.campaignId = String(row['campaign_id']);
    out.name = String(row['name']);
    out.status = String(row['status']) as CampaignStatus;
    out.stagePhase = String(row['stage_phase']) as CampaignStagePhase;
    out.activeBucketId = row['active_bucket_id'] === null ? null : String(row['active_bucket_id']);
    out.manifest = manifest;
    out.manifestDigest = digestFromHex(String(row['manifest_digest_hex']));
    out.baseRevision = String(row['base_revision']);
    out.lockHash = digestFromHex(String(row['lock_hash_hex']));
    out.driverConstraint = row['driver_constraint'] === null || row['driver_constraint'] === undefined
      ? null
      : String(row['driver_constraint']);
    out.currentGeneration = Number(row['current_generation']);
    out.evaluationsUsed = Number(row['evaluations_used']);
    out.preemptionsCount = Number(row['preemptions_count']);
    out.createdAtWallMs = Number(row['created_at_wall_ms']);
    out.updatedAtWallMs = Number(row['updated_at_wall_ms']);
    return out;
  }

  #hydrateIslandRow(row: SqlRow): IslandRecord {
    const out = createNullRecord<{
      campaignId: string;
      islandId: number;
      activeTeamConfigId: string;
      currentGeneration: number;
      consecutiveNoGainGenerations: number;
      consecutivePathologyRuns: number;
      lastHypervolume: number;
      bestRooflineHeadroom: number | null;
    }>();
    out.campaignId = String(row['campaign_id']);
    out.islandId = Number(row['island_id']);
    out.activeTeamConfigId = String(row['active_team_config_id']);
    out.currentGeneration = Number(row['current_generation']);
    out.consecutiveNoGainGenerations = Number(row['consecutive_no_gain_generations']);
    out.consecutivePathologyRuns = Number(row['consecutive_pathology_runs']);
    out.lastHypervolume = Number(row['last_hypervolume']);
    out.bestRooflineHeadroom = row['best_roofline_headroom'] === null ? null : Number(row['best_roofline_headroom']);
    return out;
  }

  #hydrateTeamConfigRow(row: SqlRow): TeamConfigRecord {
    const out = createNullRecord<{
      teamConfigId: string;
      campaignId: string;
      islandId: number;
      parentTeamConfigId: string | null;
      createdGeneration: number;
      status: TeamConfigStatus;
      trialBudgetGenerations: number;
      trialUsedGenerations: number;
      diagnosis: TeamPatchDiagnosis | null;
      patchCasDigest: Digest | null;
      paretoAdvances: number;
      nicheDiscoveries: number;
    }>();
    out.teamConfigId = String(row['team_config_id']);
    out.campaignId = String(row['campaign_id']);
    out.islandId = Number(row['island_id']);
    out.parentTeamConfigId = row['parent_team_config_id'] === null ? null : String(row['parent_team_config_id']);
    out.createdGeneration = Number(row['created_generation']);
    out.status = String(row['status']) as TeamConfigStatus;
    out.trialBudgetGenerations = Number(row['trial_budget_generations']);
    out.trialUsedGenerations = Number(row['trial_used_generations']);
    out.diagnosis = row['diagnosis_json'] === null ? null : parseTeamDiagnosisJson(String(row['diagnosis_json']));
    out.patchCasDigest = row['patch_cas_digest_hex'] === null ? null : digestFromHex(String(row['patch_cas_digest_hex']));
    out.paretoAdvances = Number(row['pareto_advances']);
    out.nicheDiscoveries = Number(row['niche_discoveries']);
    return out;
  }

  #hydrateIndividualRow(row: SqlRow): IndividualRecord {
    const out = createNullRecord<{
      individualId: string;
      campaignId: string;
      islandId: number;
      generation: number;
      bucketId: string | null;
      teamConfigId: string;
      modelId: string;
      trackId: string | null;
      mutationKind: IndividualMutationKind;
      status: IndividualStatus;
      failureReason: string | null;
      nicheKey: string | null;
      paretoRank: number | null;
      crowdingDistance: number | null;
      scalarFitness: number | null;
      offspringCount: number;
      codeSliceCasDigest: Digest | null;
      evidenceDigest: Digest | null;
      verdictReceiptCasDigest: Digest | null;
      outputArtifacts: readonly ArtifactRef[];
      metrics: Readonly<Record<string, number>>;
      bucketMetrics?: readonly BucketMetricEntry[];
      hardwareDiagnostics?: HardwareDiagnostics;
      hardwareProvenance?: HardwareProvenance;
      findings?: readonly StructuredFinding[];
      createdAtWallMs: number;
    }>();
    out.individualId = String(row['individual_id']);
    out.campaignId = String(row['campaign_id']);
    out.islandId = Number(row['island_id']);
    out.generation = Number(row['generation']);
    out.bucketId = row['bucket_id'] === null ? null : String(row['bucket_id']);
    out.teamConfigId = String(row['team_config_id']);
    out.modelId = String(row['model_id']);
    out.trackId = row['track_id'] === null ? null : String(row['track_id']);
    out.mutationKind = String(row['mutation_kind']) as IndividualMutationKind;
    out.status = String(row['status']) as IndividualStatus;
    out.failureReason = row['failure_reason'] === null ? null : String(row['failure_reason']);
    out.nicheKey = row['niche_key'] === null ? null : String(row['niche_key']);
    out.paretoRank = row['pareto_rank'] === null ? null : Number(row['pareto_rank']);
    out.crowdingDistance = Number(row['crowding_is_boundary']) === 1
      ? Number.POSITIVE_INFINITY
      : row['crowding_distance'] === null
        ? null
        : Number(row['crowding_distance']);
    out.scalarFitness = row['scalar_fitness'] === null ? null : Number(row['scalar_fitness']);
    out.offspringCount = Number(row['offspring_count']);
    out.codeSliceCasDigest = row['code_slice_cas_digest_hex'] === null
      ? null
      : digestFromHex(String(row['code_slice_cas_digest_hex']));
    out.evidenceDigest = row['evidence_digest_hex'] === null
      ? null
      : digestFromHex(String(row['evidence_digest_hex']));
    out.verdictReceiptCasDigest = row['verdict_receipt_cas_digest_hex'] === null
      ? null
      : digestFromHex(String(row['verdict_receipt_cas_digest_hex']));
    out.outputArtifacts = parseArtifactRefsJson(String(row['output_artifacts_json']));
    out.metrics = parseMetricsRecordJson(String(row['metrics_json']));
    if (row['bucket_metrics_json'] !== null) {
      out.bucketMetrics = parseBucketMetricsJson(String(row['bucket_metrics_json']));
    }
    if (row['hardware_diagnostics_json'] !== null) {
      out.hardwareDiagnostics = parseHardwareDiagnosticsJson(String(row['hardware_diagnostics_json']));
    }
    if (row['hardware_provenance_json'] !== null) {
      out.hardwareProvenance = parseHardwareProvenanceJson(String(row['hardware_provenance_json']));
    }
    if (row['findings_json'] !== null) {
      out.findings = parseStructuredFindingsJson(String(row['findings_json']));
    }
    out.createdAtWallMs = Number(row['created_at_wall_ms']);
    return out as IndividualRecord;
  }

  createCampaign(lease: CampaignLease, input: CreateCampaignInput): Promise<CampaignRecord> {
    return this.enqueue(() => {
      assertSafeId(input.campaignId, 'campaignId');
      assertDigest(input.manifestDigest, 'manifestDigest');
      assertDigest(input.lockHash, 'lockHash');
      const validatedManifest = parseEvolutionCampaignDocument(input.manifest);
      const defaultPhase: CampaignStagePhase = validatedManifest.spec.stages.mode === 'specialist-then-portfolio'
        ? 'specialist'
        : 'single-target';
      const stagePhase = input.stagePhase ?? defaultPhase;
      const activeBucketId = input.activeBucketId !== undefined
        ? input.activeBucketId
        : validatedManifest.spec.stages.mode === 'specialist-then-portfolio'
          ? validatedManifest.spec.stages.specialistBuckets[0]!.id
          : null;

      return this.#inWriteTransaction(lease, now => {
        const existing = this.#db
          .prepare('SELECT campaign_id FROM campaigns WHERE campaign_id = ?;')
          .get(input.campaignId);
        if (existing) {
          throw new EvolutionError('EVOLUTION_CONFLICT', `campaign "${input.campaignId}" already exists`);
        }

        const driverConstraint = input.driverConstraint ?? null;
        if (
          driverConstraint !== null
          && (driverConstraint.length < 1 || driverConstraint.length > 128 || !/^[\x20-\x7E]+$/.test(driverConstraint))
        ) {
          throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'invalid driverConstraint', '/driverConstraint');
        }

        const manifestJson = canonicalizeJson(validatedManifest);
        this.#db
          .prepare(
            `INSERT INTO campaigns (
              campaign_id, name, status, stage_phase, active_bucket_id,
              manifest_json, manifest_digest_hex, base_revision, lock_hash_hex, driver_constraint,
              current_generation, evaluations_used, preemptions_count,
              created_at_wall_ms, updated_at_wall_ms
            ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?);`,
          )
          .run(
            input.campaignId,
            validatedManifest.metadata.name,
            stagePhase,
            activeBucketId,
            manifestJson,
            input.manifestDigest.hex,
            input.baseRevision,
            input.lockHash.hex,
            driverConstraint,
            now.wallMs,
            now.wallMs,
          );

        for (let islandId = 0; islandId < validatedManifest.spec.population.islands; islandId++) {
          const baselineTeamId = `${input.campaignId}-isl${islandId}-team-baseline`;
          this.#db
            .prepare(
              `INSERT INTO team_configs (
                team_config_id, campaign_id, island_id, parent_team_config_id,
                created_generation, status, trial_budget_generations, trial_used_generations,
                diagnosis_json, patch_cas_digest_hex, pareto_advances, niche_discoveries
              ) VALUES (?, ?, ?, NULL, 0, 'baseline', 0, 0, NULL, NULL, 0, 0);`,
            )
            .run(baselineTeamId, input.campaignId, islandId);

          this.#db
            .prepare(
              `INSERT INTO islands (
                campaign_id, island_id, active_team_config_id, current_generation,
                consecutive_no_gain_generations, consecutive_pathology_runs,
                last_hypervolume, best_roofline_headroom
              ) VALUES (?, ?, ?, 0, 0, 0, 0, NULL);`,
            )
            .run(input.campaignId, islandId, baselineTeamId);
        }

        if (input.modelIds !== undefined) {
          for (const modelId of input.modelIds) {
            this.#db
              .prepare(
                `INSERT INTO model_bandit_arms (
                  campaign_id, model_id, pull_count, total_reward, mean_reward, last_pulled_generation
                ) VALUES (?, ?, 0, 0, 0, NULL)
                ON CONFLICT (campaign_id, model_id) DO NOTHING;`,
              )
              .run(input.campaignId, modelId);
          }
        }

        const row = this.#db
          .prepare('SELECT * FROM campaigns WHERE campaign_id = ?;')
          .get(input.campaignId) as SqlRow;
        return this.#hydrateCampaignRow(row);
      });
    });
  }

  getCampaign(campaignId: string): Promise<CampaignRecord | null> {
    return this.enqueue(() => {
      const row = this.#db
        .prepare('SELECT * FROM campaigns WHERE campaign_id = ?;')
        .get(campaignId) as SqlRow | undefined;
      return row ? this.#hydrateCampaignRow(row) : null;
    });
  }

  listCampaigns(): Promise<readonly CampaignRecord[]> {
    return this.enqueue(() => {
      const rows = this.#db
        .prepare('SELECT * FROM campaigns ORDER BY created_at_wall_ms ASC, campaign_id ASC;')
        .all() as SqlRow[];
      return rows.map(r => this.#hydrateCampaignRow(r));
    });
  }

  updateCampaignProgress(lease: CampaignLease, input: UpdateCampaignProgressInput): Promise<CampaignRecord> {
    return this.enqueue(() => {
      return this.#inWriteTransaction(lease, now => {
        const existing = this.#db
          .prepare('SELECT * FROM campaigns WHERE campaign_id = ?;')
          .get(input.campaignId) as SqlRow | undefined;
        if (!existing) {
          throw new EvolutionError('EVOLUTION_NOT_FOUND', `campaign "${input.campaignId}" not found`);
        }
        const nextStatus = input.status ?? String(existing['status']);
        const nextPhase = input.stagePhase ?? String(existing['stage_phase']);
        const nextBucket = input.activeBucketId !== undefined
          ? input.activeBucketId
          : (existing['active_bucket_id'] === null ? null : String(existing['active_bucket_id']));
        const nextDriverConstraint = input.driverConstraint !== undefined
          ? input.driverConstraint
          : (existing['driver_constraint'] === null || existing['driver_constraint'] === undefined
            ? null
            : String(existing['driver_constraint']));
        if (
          nextDriverConstraint !== null
          && (nextDriverConstraint.length < 1 || nextDriverConstraint.length > 128 || !/^[\x20-\x7E]+$/.test(nextDriverConstraint))
        ) {
          throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'invalid driverConstraint', '/driverConstraint');
        }
        const nextGen = input.currentGeneration ?? Number(existing['current_generation']);

        this.#db
          .prepare(
            `UPDATE campaigns
             SET status = ?, stage_phase = ?, active_bucket_id = ?, driver_constraint = ?, current_generation = ?, updated_at_wall_ms = ?
             WHERE campaign_id = ?;`,
          )
          .run(nextStatus, nextPhase, nextBucket, nextDriverConstraint, nextGen, now.wallMs, input.campaignId);

        const updated = this.#db
          .prepare('SELECT * FROM campaigns WHERE campaign_id = ?;')
          .get(input.campaignId) as SqlRow;
        return this.#hydrateCampaignRow(updated);
      });
    });
  }

  getIsland(campaignId: string, islandId: number): Promise<IslandRecord | null> {
    return this.enqueue(() => {
      const row = this.#db
        .prepare('SELECT * FROM islands WHERE campaign_id = ? AND island_id = ?;')
        .get(campaignId, islandId) as SqlRow | undefined;
      return row ? this.#hydrateIslandRow(row) : null;
    });
  }

  listIslands(campaignId: string): Promise<readonly IslandRecord[]> {
    return this.enqueue(() => {
      const rows = this.#db
        .prepare('SELECT * FROM islands WHERE campaign_id = ? ORDER BY island_id ASC;')
        .all(campaignId) as SqlRow[];
      return rows.map(r => this.#hydrateIslandRow(r));
    });
  }

  updateIslandProgress(lease: CampaignLease, input: UpdateIslandProgressInput): Promise<IslandRecord> {
    return this.enqueue(() => {
      return this.#inWriteTransaction(lease, () => {
        const existing = this.#db
          .prepare('SELECT * FROM islands WHERE campaign_id = ? AND island_id = ?;')
          .get(input.campaignId, input.islandId) as SqlRow | undefined;
        if (!existing) {
          throw new EvolutionError(
            'EVOLUTION_NOT_FOUND',
            `island ${input.islandId} not found in campaign "${input.campaignId}"`,
          );
        }

        const activeTeam = input.activeTeamConfigId ?? String(existing['active_team_config_id']);
        const currentGen = input.currentGeneration ?? Number(existing['current_generation']);
        const noGain = input.consecutiveNoGainGenerations ?? Number(existing['consecutive_no_gain_generations']);
        const pathology = input.consecutivePathologyRuns ?? Number(existing['consecutive_pathology_runs']);
        const lastHv = input.lastHypervolume ?? Number(existing['last_hypervolume']);
        const bestHeadroom = input.bestRooflineHeadroom !== undefined
          ? input.bestRooflineHeadroom
          : (existing['best_roofline_headroom'] === null ? null : Number(existing['best_roofline_headroom']));

        this.#db
          .prepare(
            `UPDATE islands
             SET active_team_config_id = ?, current_generation = ?, consecutive_no_gain_generations = ?,
                 consecutive_pathology_runs = ?, last_hypervolume = ?, best_roofline_headroom = ?
             WHERE campaign_id = ? AND island_id = ?;`,
          )
          .run(
            activeTeam,
            currentGen,
            noGain,
            pathology,
            lastHv,
            bestHeadroom,
            input.campaignId,
            input.islandId,
          );

        const updated = this.#db
          .prepare('SELECT * FROM islands WHERE campaign_id = ? AND island_id = ?;')
          .get(input.campaignId, input.islandId) as SqlRow;
        return this.#hydrateIslandRow(updated);
      });
    });
  }

  createTrialTeamConfig(lease: CampaignLease, input: CreateTrialTeamConfigInput): Promise<TeamConfigRecord> {
    return this.enqueue(() => {
      assertSafeId(input.teamConfigId, 'teamConfigId');
      assertSafeId(input.parentTeamConfigId, 'parentTeamConfigId');
      assertDigest(input.patchCasDigest, 'patchCasDigest');
      if (!Number.isSafeInteger(input.trialBudgetGenerations) || input.trialBudgetGenerations < 1 || input.trialBudgetGenerations > 8) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'trialBudgetGenerations must be within 1..8');
      }
      const validatedDiagnosis = parseTeamDiagnosisValue(
        sanitizeUntrustedValue(input.diagnosis, { maxBytes: 4_096, path: '/diagnosis' }),
        '/diagnosis',
      );

      return this.#inWriteTransaction(lease, () => {
        const diagJson = canonicalizeJson(validatedDiagnosis);
        this.#db
          .prepare(
            `INSERT INTO team_configs (
              team_config_id, campaign_id, island_id, parent_team_config_id,
              created_generation, status, trial_budget_generations, trial_used_generations,
              diagnosis_json, patch_cas_digest_hex, pareto_advances, niche_discoveries
            ) VALUES (?, ?, ?, ?, ?, 'trial', ?, 0, ?, ?, 0, 0);`,
          )
          .run(
            input.teamConfigId,
            input.campaignId,
            input.islandId,
            input.parentTeamConfigId,
            input.createdGeneration,
            input.trialBudgetGenerations,
            diagJson,
            input.patchCasDigest.hex,
          );

        this.#db
          .prepare('UPDATE islands SET active_team_config_id = ? WHERE campaign_id = ? AND island_id = ?;')
          .run(input.teamConfigId, input.campaignId, input.islandId);

        const row = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(input.teamConfigId) as SqlRow;
        return this.#hydrateTeamConfigRow(row);
      });
    });
  }

  getTeamConfig(teamConfigId: string): Promise<TeamConfigRecord | null> {
    return this.enqueue(() => {
      const row = this.#db
        .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
        .get(teamConfigId) as SqlRow | undefined;
      return row ? this.#hydrateTeamConfigRow(row) : null;
    });
  }

  listTeamConfigs(campaignId: string, islandId?: number): Promise<readonly TeamConfigRecord[]> {
    return this.enqueue(() => {
      const rows = islandId === undefined
        ? (this.#db
          .prepare('SELECT * FROM team_configs WHERE campaign_id = ? ORDER BY created_generation ASC, team_config_id ASC;')
          .all(campaignId) as SqlRow[])
        : (this.#db
          .prepare('SELECT * FROM team_configs WHERE campaign_id = ? AND island_id = ? ORDER BY created_generation ASC, team_config_id ASC;')
          .all(campaignId, islandId) as SqlRow[]);
      return rows.map(r => this.#hydrateTeamConfigRow(r));
    });
  }

  /**
   * Record one generation's outcome against a `team_config`.
   * Preempted runs never consume `trial_used_generations`. Advancing Pareto or niche elites
   * promotes `'trial' -> 'promoted'`; exhausting `trial_budget_generations` without advance
   * transitions `'trial' -> 'rolled_back'` and restores `parent_team_config_id` on the island.
   */
  recordTeamTrialGeneration(lease: CampaignLease, input: RecordTeamTrialGenerationInput): Promise<TeamConfigRecord> {
    return this.enqueue(() => {
      return this.#inWriteTransaction(lease, () => {
        const row = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(input.teamConfigId) as SqlRow | undefined;
        if (!row) {
          throw new EvolutionError('EVOLUTION_NOT_FOUND', `team_config "${input.teamConfigId}" not found`);
        }
        if (input.preempted === true) {
          return this.#hydrateTeamConfigRow(row);
        }

        const currentStatus = String(row['status']) as TeamConfigStatus;
        const paretoAdvances = Number(row['pareto_advances']) + (input.advancedPareto ? 1 : 0);
        const nicheDiscoveries = Number(row['niche_discoveries']) + (input.discoveredNiche ? 1 : 0);
        const trialBudget = Number(row['trial_budget_generations']);
        const trialUsed = currentStatus === 'trial'
          ? Number(row['trial_used_generations']) + 1
          : Number(row['trial_used_generations']);

        let nextStatus: TeamConfigStatus = currentStatus;
        if (currentStatus === 'trial') {
          if (paretoAdvances > 0 || nicheDiscoveries > 0) {
            nextStatus = 'promoted';
          } else if (trialUsed >= trialBudget) {
            nextStatus = 'rolled_back';
          }
        }

        this.#db
          .prepare(
            `UPDATE team_configs
             SET status = ?, trial_used_generations = ?, pareto_advances = ?, niche_discoveries = ?
             WHERE team_config_id = ?;`,
          )
          .run(nextStatus, trialUsed, paretoAdvances, nicheDiscoveries, input.teamConfigId);

        if (nextStatus === 'rolled_back' && row['parent_team_config_id'] !== null) {
          this.#db
            .prepare(
              'UPDATE islands SET active_team_config_id = ? WHERE campaign_id = ? AND island_id = ? AND active_team_config_id = ?;',
            )
            .run(
              String(row['parent_team_config_id']),
              String(row['campaign_id']),
              Number(row['island_id']),
              input.teamConfigId,
            );
        }

        const updated = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(input.teamConfigId) as SqlRow;
        return this.#hydrateTeamConfigRow(updated);
      });
    });
  }

  promoteTeamConfig(lease: CampaignLease, teamConfigId: string): Promise<TeamConfigRecord> {
    return this.enqueue(() => {
      return this.#inWriteTransaction(lease, () => {
        const row = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(teamConfigId) as SqlRow | undefined;
        if (!row) {
          throw new EvolutionError('EVOLUTION_NOT_FOUND', `team_config "${teamConfigId}" not found`);
        }
        this.#db
          .prepare("UPDATE team_configs SET status = 'promoted' WHERE team_config_id = ?;")
          .run(teamConfigId);
        this.#db
          .prepare('UPDATE islands SET active_team_config_id = ? WHERE campaign_id = ? AND island_id = ?;')
          .run(teamConfigId, String(row['campaign_id']), Number(row['island_id']));
        const updated = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(teamConfigId) as SqlRow;
        return this.#hydrateTeamConfigRow(updated);
      });
    });
  }

  rollbackTeamConfig(lease: CampaignLease, teamConfigId: string): Promise<TeamConfigRecord> {
    return this.enqueue(() => {
      return this.#inWriteTransaction(lease, () => {
        const row = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(teamConfigId) as SqlRow | undefined;
        if (!row) {
          throw new EvolutionError('EVOLUTION_NOT_FOUND', `team_config "${teamConfigId}" not found`);
        }
        if (row['parent_team_config_id'] === null) {
          throw new EvolutionError('EVOLUTION_STORE_ERROR', 'baseline team_config cannot be rolled back');
        }
        this.#db
          .prepare("UPDATE team_configs SET status = 'rolled_back' WHERE team_config_id = ?;")
          .run(teamConfigId);
        this.#db
          .prepare(
            'UPDATE islands SET active_team_config_id = ? WHERE campaign_id = ? AND island_id = ? AND active_team_config_id = ?;',
          )
          .run(String(row['parent_team_config_id']), String(row['campaign_id']), Number(row['island_id']), teamConfigId);
        const updated = this.#db
          .prepare('SELECT * FROM team_configs WHERE team_config_id = ?;')
          .get(teamConfigId) as SqlRow;
        return this.#hydrateTeamConfigRow(updated);
      });
    });
  }

  recordIndividual(lease: CampaignLease, input: RecordIndividualInput): Promise<IndividualRecord> {
    return this.enqueue(() => {
      assertSafeId(input.individualId, 'individualId');
      assertSafeId(input.campaignId, 'campaignId');
      assertSafeId(input.teamConfigId, 'teamConfigId');
      if (input.codeSliceCasDigest !== null) assertDigest(input.codeSliceCasDigest, 'codeSliceCasDigest');
      if (input.evidenceDigest !== null) assertDigest(input.evidenceDigest, 'evidenceDigest');
      if (input.verdictReceiptCasDigest !== null) assertDigest(input.verdictReceiptCasDigest, 'verdictReceiptCasDigest');

      const validatedMetrics = parseMetricsRecordJson(input.metrics, '/metrics');
      const validatedArtifacts = parseArtifactRefsJson(input.outputArtifacts, '/outputArtifacts');
      const validatedBuckets = input.bucketMetrics !== undefined
        ? parseBucketMetricsJson(input.bucketMetrics)
        : undefined;
      const validatedDiagnostics = input.hardwareDiagnostics !== undefined
        ? parseHardwareDiagnosticsJson(input.hardwareDiagnostics)
        : undefined;
      const validatedProvenance = input.hardwareProvenance !== undefined
        ? parseHardwareProvenanceJson(input.hardwareProvenance)
        : undefined;
      const validatedFindings = input.findings !== undefined
        ? parseStructuredFindingsJson(input.findings)
        : undefined;

      let crowdingCol: number | null = null;
      let crowdingBoundaryCol = 0;
      if (input.crowdingDistance !== null) {
        if (input.crowdingDistance === Number.POSITIVE_INFINITY) {
          crowdingBoundaryCol = 1;
          crowdingCol = null;
        } else if (!Number.isFinite(input.crowdingDistance) || Object.is(input.crowdingDistance, -0) || input.crowdingDistance < 0) {
          throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'crowdingDistance must be >= 0 or +Infinity');
        } else {
          crowdingCol = input.crowdingDistance;
        }
      }

      if (input.scalarFitness !== null && (!Number.isFinite(input.scalarFitness) || Object.is(input.scalarFitness, -0))) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'scalarFitness must be a finite non-negative-zero number');
      }

      return this.#inWriteTransaction(lease, now => {
        const campaignRow = this.#db
          .prepare('SELECT evaluations_used, preemptions_count, manifest_digest_hex, manifest_json FROM campaigns WHERE campaign_id = ?;')
          .get(input.campaignId) as SqlRow | undefined;
        if (!campaignRow) {
          throw new EvolutionError('EVOLUTION_NOT_FOUND', `campaign "${input.campaignId}" not found`);
        }

        const teamRow = this.#db
          .prepare('SELECT campaign_id, island_id FROM team_configs WHERE team_config_id = ?;')
          .get(input.teamConfigId) as SqlRow | undefined;
        if (!teamRow || String(teamRow['campaign_id']) !== input.campaignId || Number(teamRow['island_id']) !== input.islandId) {
          throw new EvolutionError(
            'EVOLUTION_STORE_ERROR',
            `team_config "${input.teamConfigId}" does not belong to (${input.campaignId}, island ${input.islandId})`,
          );
        }

        const isPreempted = input.status === 'preempted';
        const shouldCountEvaluation = !isPreempted && (input.countEvaluation ?? true);
        if (shouldCountEvaluation) {
          const manifest = this.#parseCachedManifest(
            input.campaignId,
            String(campaignRow['manifest_digest_hex']),
            String(campaignRow['manifest_json']),
          );
          const used = Number(campaignRow['evaluations_used']);
          if (used >= manifest.spec.budgets.maxEvaluations) {
            throw new EvolutionError(
              'EVOLUTION_BUDGET_EXCEEDED',
              `campaign maxEvaluations (${manifest.spec.budgets.maxEvaluations}) reached`,
            );
          }
        }

        this.#db
          .prepare(
            `INSERT INTO individuals (
              individual_id, campaign_id, island_id, generation, bucket_id,
              team_config_id, model_id, track_id, mutation_kind, status,
              failure_reason, niche_key, pareto_rank, crowding_distance, crowding_is_boundary,
              scalar_fitness, offspring_count, code_slice_cas_digest_hex,
              evidence_digest_hex, verdict_receipt_cas_digest_hex,
              output_artifacts_json, metrics_json, bucket_metrics_json,
              hardware_diagnostics_json, hardware_provenance_json, findings_json,
              created_at_wall_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          )
          .run(
            input.individualId,
            input.campaignId,
            input.islandId,
            input.generation,
            input.bucketId,
            input.teamConfigId,
            input.modelId,
            input.trackId,
            input.mutationKind,
            input.status,
            input.failureReason,
            input.nicheKey,
            input.paretoRank,
            crowdingCol,
            crowdingBoundaryCol,
            input.scalarFitness,
            input.offspringCount ?? 0,
            input.codeSliceCasDigest?.hex ?? null,
            input.evidenceDigest?.hex ?? null,
            input.verdictReceiptCasDigest?.hex ?? null,
            canonicalizeJson(validatedArtifacts),
            canonicalizeJson(validatedMetrics),
            validatedBuckets !== undefined ? canonicalizeJson(validatedBuckets) : null,
            validatedDiagnostics !== undefined ? canonicalizeJson(validatedDiagnostics) : null,
            validatedProvenance !== undefined ? canonicalizeJson(validatedProvenance) : null,
            validatedFindings !== undefined ? canonicalizeJson(validatedFindings) : null,
            now.wallMs,
          );

        if (input.lineageEdges !== undefined && input.lineageEdges.length > 0) {
          this.#insertLineageEdgesSync(input.lineageEdges);
        }

        if (isPreempted) {
          this.#db
            .prepare('UPDATE campaigns SET preemptions_count = preemptions_count + 1, updated_at_wall_ms = ? WHERE campaign_id = ?;')
            .run(now.wallMs, input.campaignId);
        } else if (shouldCountEvaluation) {
          this.#db
            .prepare('UPDATE campaigns SET evaluations_used = evaluations_used + 1, updated_at_wall_ms = ? WHERE campaign_id = ?;')
            .run(now.wallMs, input.campaignId);
        }

        const inserted = this.#db
          .prepare('SELECT * FROM individuals WHERE individual_id = ?;')
          .get(input.individualId) as SqlRow;
        return this.#hydrateIndividualRow(inserted);
      });
    });
  }

  getIndividual(individualId: string): Promise<IndividualRecord | null> {
    return this.enqueue(() => {
      const row = this.#db
        .prepare('SELECT * FROM individuals WHERE individual_id = ?;')
        .get(individualId) as SqlRow | undefined;
      return row ? this.#hydrateIndividualRow(row) : null;
    });
  }

  listIndividuals(campaignId: string, filter: ListIndividualsFilter = {}): Promise<readonly IndividualRecord[]> {
    return this.enqueue(() => {
      const clauses: string[] = ['campaign_id = ?'];
      const params: SQLInputValue[] = [campaignId];

      if (filter.islandId !== undefined) {
        clauses.push('island_id = ?');
        params.push(filter.islandId);
      }
      if (filter.status !== undefined && filter.status.length > 0) {
        clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
        for (const st of filter.status) params.push(st);
      }
      if (filter.bucketId !== undefined) {
        if (filter.bucketId === null) {
          clauses.push('bucket_id IS NULL');
        } else {
          clauses.push('bucket_id = ?');
          params.push(filter.bucketId);
        }
      }
      if (filter.nicheKey !== undefined) {
        clauses.push('niche_key = ?');
        params.push(filter.nicheKey);
      }

      const sql = `SELECT * FROM individuals WHERE ${clauses.join(' AND ')} ORDER BY generation ASC, individual_id ASC;`;
      const rows = this.#db.prepare(sql).all(...params) as SqlRow[];
      return rows.map(r => this.#hydrateIndividualRow(r));
    });
  }

  /**
   * Return the winning fertile elite per `nicheKey` on `(campaignId, islandId)`, breaking ties
   * deterministically by `paretoRank` asc, `scalarFitness` desc, `crowdingDistance` desc, and `individualId` asc.
   */
  getIslandNicheElites(
    campaignId: string,
    islandId: number,
    bucketId?: string | null,
  ): Promise<ReadonlyMap<string, IndividualRecord>> {
    return this.enqueue(() => {
      const clauses = [
        'campaign_id = ?',
        'island_id = ?',
        "status IN ('passed', 'soft_passed')",
        'niche_key IS NOT NULL',
      ];
      const params: SQLInputValue[] = [campaignId, islandId];
      if (bucketId !== undefined) {
        if (bucketId === null) {
          clauses.push('bucket_id IS NULL');
        } else {
          clauses.push('bucket_id = ?');
          params.push(bucketId);
        }
      }
      const rows = this.#db
        .prepare(`SELECT * FROM individuals WHERE ${clauses.join(' AND ')};`)
        .all(...params) as SqlRow[];
      const elites = new Map<string, IndividualRecord>();
      for (const row of rows) {
        const candidate = this.#hydrateIndividualRow(row);
        if (candidate.nicheKey === null) continue;
        const incumbent = elites.get(candidate.nicheKey);
        if (!incumbent || compareNicheEliteBetter(candidate, incumbent) < 0) {
          elites.set(candidate.nicheKey, candidate);
        }
      }
      return elites;
    });
  }

  updateParetoRanks(
    lease: CampaignLease,
    campaignId: string,
    updates: readonly ParetoRankUpdate[],
  ): Promise<void> {
    return this.enqueue(() => {
      this.#inWriteTransaction(lease, () => {
        const stmt = this.#db.prepare(
          `UPDATE individuals
           SET pareto_rank = ?, crowding_distance = ?, crowding_is_boundary = ?, scalar_fitness = COALESCE(?, scalar_fitness)
           WHERE campaign_id = ? AND individual_id = ?;`,
        );
        for (const u of updates) {
          let crowdVal: number | null = null;
          let isBoundary = 0;
          if (u.crowdingDistance !== null) {
            if (u.crowdingDistance === Number.POSITIVE_INFINITY) {
              isBoundary = 1;
            } else if (!Number.isFinite(u.crowdingDistance) || Object.is(u.crowdingDistance, -0) || u.crowdingDistance < 0) {
              throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'invalid crowdingDistance in updateParetoRanks');
            } else {
              crowdVal = u.crowdingDistance;
            }
          }
          const scalarVal = u.scalarFitness === undefined ? null : u.scalarFitness;
          stmt.run(u.paretoRank, crowdVal, isBoundary, scalarVal, campaignId, u.individualId);
        }
      });
    });
  }

  incrementOffspringCount(lease: CampaignLease, individualId: string, delta = 1): Promise<IndividualRecord> {
    return this.enqueue(() => {
      if (!Number.isSafeInteger(delta) || delta < 1) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'delta must be an integer >= 1');
      }
      return this.#inWriteTransaction(lease, () => {
        const res = this.#db
          .prepare('UPDATE individuals SET offspring_count = offspring_count + ? WHERE individual_id = ?;')
          .run(delta, individualId);
        if (Number(res.changes) !== 1) {
          throw new EvolutionError('EVOLUTION_NOT_FOUND', `individual "${individualId}" not found`);
        }
        const row = this.#db
          .prepare('SELECT * FROM individuals WHERE individual_id = ?;')
          .get(individualId) as SqlRow;
        return this.#hydrateIndividualRow(row);
      });
    });
  }

  #insertLineageEdgesSync(edges: readonly LineageEdgeRecord[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO lineage_edges (
        campaign_id, child_individual_id, parent_individual_id, role, source_island_id, created_generation
      ) VALUES (?, ?, ?, ?, ?, ?);`,
    );
    for (const edge of edges) {
      stmt.run(
        edge.campaignId,
        edge.childIndividualId,
        edge.parentIndividualId,
        edge.role,
        edge.sourceIslandId,
        edge.createdGeneration,
      );
    }
  }

  recordLineageEdges(lease: CampaignLease, edges: readonly LineageEdgeRecord[]): Promise<void> {
    return this.enqueue(() => {
      this.#inWriteTransaction(lease, () => {
        this.#insertLineageEdgesSync(edges);
      });
    });
  }

  listLineageEdges(campaignId: string, filter: ListLineageEdgesFilter = {}): Promise<readonly LineageEdgeRecord[]> {
    return this.enqueue(() => {
      const clauses = ['campaign_id = ?'];
      const params: SQLInputValue[] = [campaignId];
      if (filter.childIndividualId !== undefined) {
        clauses.push('child_individual_id = ?');
        params.push(filter.childIndividualId);
      }
      if (filter.parentIndividualId !== undefined) {
        clauses.push('parent_individual_id = ?');
        params.push(filter.parentIndividualId);
      }
      if (filter.role !== undefined) {
        clauses.push('role = ?');
        params.push(filter.role);
      }
      const rows = this.#db
        .prepare(
          `SELECT * FROM lineage_edges
           WHERE ${clauses.join(' AND ')}
           ORDER BY created_generation ASC, child_individual_id ASC, role ASC, parent_individual_id ASC;`,
        )
        .all(...params) as SqlRow[];
      return rows.map(r => {
        const out = createNullRecord<{
          campaignId: string;
          childIndividualId: string;
          parentIndividualId: string;
          role: LineageRole;
          sourceIslandId: number;
          createdGeneration: number;
        }>();
        out.campaignId = String(r['campaign_id']);
        out.childIndividualId = String(r['child_individual_id']);
        out.parentIndividualId = String(r['parent_individual_id']);
        out.role = String(r['role']) as LineageRole;
        out.sourceIslandId = Number(r['source_island_id']);
        out.createdGeneration = Number(r['created_generation']);
        return out;
      });
    });
  }

  ensureModelBanditArms(
    lease: CampaignLease,
    campaignId: string,
    modelIds: readonly string[],
  ): Promise<readonly ModelBanditArmRecord[]> {
    return this.enqueue(() => {
      return this.#inWriteTransaction(lease, () => {
        const stmt = this.#db.prepare(
          `INSERT INTO model_bandit_arms (
            campaign_id, model_id, pull_count, total_reward, mean_reward, last_pulled_generation
          ) VALUES (?, ?, 0, 0, 0, NULL)
          ON CONFLICT (campaign_id, model_id) DO NOTHING;`,
        );
        for (const modelId of modelIds) {
          stmt.run(campaignId, modelId);
        }
        return this.#listModelBanditArmsSync(campaignId);
      });
    });
  }

  #listModelBanditArmsSync(campaignId: string): readonly ModelBanditArmRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM model_bandit_arms WHERE campaign_id = ? ORDER BY model_id ASC;')
      .all(campaignId) as SqlRow[];
    return rows.map(r => {
      const out = createNullRecord<{
        campaignId: string;
        modelId: string;
        pullCount: number;
        totalReward: number;
        meanReward: number;
        lastPulledGeneration: number | null;
      }>();
      out.campaignId = String(r['campaign_id']);
      out.modelId = String(r['model_id']);
      out.pullCount = Number(r['pull_count']);
      out.totalReward = Number(r['total_reward']);
      out.meanReward = Number(r['mean_reward']);
      out.lastPulledGeneration = r['last_pulled_generation'] === null ? null : Number(r['last_pulled_generation']);
      return out;
    });
  }

  listModelBanditArms(campaignId: string): Promise<readonly ModelBanditArmRecord[]> {
    return this.enqueue(() => this.#listModelBanditArmsSync(campaignId));
  }

  recordModelBanditReward(lease: CampaignLease, input: RecordModelBanditRewardInput): Promise<ModelBanditArmRecord> {
    return this.enqueue(() => {
      if (!Number.isFinite(input.reward) || Object.is(input.reward, -0) || input.reward < 0) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'bandit reward must be finite >= 0');
      }
      return this.#inWriteTransaction(lease, () => {
        const existing = this.#db
          .prepare('SELECT * FROM model_bandit_arms WHERE campaign_id = ? AND model_id = ?;')
          .get(input.campaignId, input.modelId) as SqlRow | undefined;
        const nextPulls = existing ? Number(existing['pull_count']) + 1 : 1;
        const nextTotal = (existing ? Number(existing['total_reward']) : 0) + input.reward;
        const nextMean = nextTotal / nextPulls;

        this.#db
          .prepare(
            `INSERT INTO model_bandit_arms (
              campaign_id, model_id, pull_count, total_reward, mean_reward, last_pulled_generation
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (campaign_id, model_id) DO UPDATE SET
              pull_count = excluded.pull_count,
              total_reward = excluded.total_reward,
              mean_reward = excluded.mean_reward,
              last_pulled_generation = excluded.last_pulled_generation;`,
          )
          .run(input.campaignId, input.modelId, nextPulls, nextTotal, nextMean, input.generation);

        const row = this.#db
          .prepare('SELECT * FROM model_bandit_arms WHERE campaign_id = ? AND model_id = ?;')
          .get(input.campaignId, input.modelId) as SqlRow;
        const out = createNullRecord<{
          campaignId: string;
          modelId: string;
          pullCount: number;
          totalReward: number;
          meanReward: number;
          lastPulledGeneration: number | null;
        }>();
        out.campaignId = String(row['campaign_id']);
        out.modelId = String(row['model_id']);
        out.pullCount = Number(row['pull_count']);
        out.totalReward = Number(row['total_reward']);
        out.meanReward = Number(row['mean_reward']);
        out.lastPulledGeneration = row['last_pulled_generation'] === null ? null : Number(row['last_pulled_generation']);
        return out;
      });
    });
  }

  /**
   * Persist a content-addressed blob under `<campaignRoot>/cas/sha256/<hex>` with `O_NOFOLLOW`,
   * `nlink === 1`, and `0o400` read-only permissions.
   */
  writeCasBlob(content: Uint8Array | string): Promise<WrittenCasBlob> {
    return this.enqueue(async () => {
      const bytes = typeof content === 'string'
        ? Buffer.from(content, 'utf8')
        : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
      const hex = createHash('sha256').update(bytes).digest('hex');

      await ensureNonSymlinkDirectory(this.campaignRoot, false);
      const casDir = join(this.campaignRoot, 'cas');
      const shaDir = join(casDir, 'sha256');
      await ensureNonSymlinkDirectory(casDir, true);
      await ensureNonSymlinkDirectory(shaDir, true);

      const finalPath = join(shaDir, hex);
      const casRelPath = `cas/sha256/${hex}`;
      const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;

      const existing = await lstat(finalPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        if (err.code === 'ELOOP') {
          throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${finalPath}`, finalPath);
        }
        throw err;
      });

      if (existing !== null) {
        if (existing.isSymbolicLink()) {
          throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `CAS blob cannot be a symlink: ${finalPath}`, finalPath);
        }
        if (!existing.isFile() || existing.nlink !== 1) {
          throw new EvolutionError('ARTIFACT_INVALID', `CAS blob must be an unlinked regular file: ${finalPath}`, finalPath);
        }
        const verified = await this.#readCasBlobRawNoQueue(hex, bytes.byteLength);
        if (verified.byteLength !== bytes.byteLength) {
          throw new EvolutionError('ARTIFACT_INVALID', `CAS blob size mismatch for ${hex}`, finalPath);
        }
        return {
          digest: digestFromHex(hex),
          byteLength: bytes.byteLength,
          casPath: finalPath,
          casRelPath,
        };
      }

      const tempPath = join(shaDir, `.tmp-${hex}-${randomBytes(6).toString('hex')}`);
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

      return {
        digest: digestFromHex(hex),
        byteLength: bytes.byteLength,
        casPath: finalPath,
        casRelPath,
      };
    });
  }

  async #readCasBlobRawNoQueue(digestHex: string, maxBytes = 67_108_864): Promise<Buffer> {
    if (!SHA256_HEX_RE.test(digestHex)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `invalid sha256 hex "${digestHex}"`);
    }
    await ensureNonSymlinkDirectory(this.campaignRoot, false);
    await ensureNonSymlinkDirectory(join(this.campaignRoot, 'cas'), false);
    await ensureNonSymlinkDirectory(join(this.campaignRoot, 'cas', 'sha256'), false);

    const blobPath = join(this.campaignRoot, 'cas', 'sha256', digestHex);
    const st = await lstat(blobPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        throw new EvolutionError('ARTIFACT_MISSING', `CAS blob not found: ${digestHex}`, blobPath);
      }
      if (err.code === 'ELOOP') {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${blobPath}`, blobPath);
      }
      throw err;
    });
    if (st.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `CAS blob cannot be a symlink: ${blobPath}`, blobPath);
    }
    if (!st.isFile() || st.nlink !== 1 || st.size > maxBytes) {
      throw new EvolutionError('ARTIFACT_INVALID', `CAS blob failed stat checks: ${blobPath}`, blobPath);
    }

    const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const handle = await open(blobPath, fsConstants.O_RDONLY | noFollow);
    try {
      const fdStat = await handle.stat();
      if (!fdStat.isFile() || fdStat.nlink !== 1 || fdStat.size !== st.size || fdStat.size > maxBytes) {
        throw new EvolutionError('ARTIFACT_INVALID', `CAS blob changed during read: ${blobPath}`, blobPath);
      }
      const buf = Buffer.alloc(fdStat.size);
      let offset = 0;
      while (offset < fdStat.size) {
        const res = await handle.read(buf, offset, fdStat.size - offset, offset);
        if (res.bytesRead === 0) break;
        offset += res.bytesRead;
      }
      if (offset !== fdStat.size) {
        throw new EvolutionError('ARTIFACT_INVALID', `incomplete CAS blob read: ${blobPath}`, blobPath);
      }
      const observedHex = createHash('sha256').update(buf).digest('hex');
      if (observedHex !== digestHex) {
        throw new EvolutionError('ARTIFACT_INVALID', `CAS blob SHA-256 mismatch for ${digestHex}`, blobPath);
      }
      return buf;
    } finally {
      await handle.close();
    }
  }

  readCasBlob(digestHex: string, maxBytes = 67_108_864): Promise<Buffer> {
    return this.enqueue(() => this.#readCasBlobRawNoQueue(digestHex, maxBytes));
  }

  recordScratchpadSnapshot(
    lease: CampaignLease,
    input: RecordScratchpadSnapshotInput,
  ): Promise<ScratchpadSnapshotRecord> {
    return this.enqueue(() => {
      assertSafeId(input.snapshotId, 'snapshotId');
      assertSafeId(input.campaignId, 'campaignId');
      assertDigest(input.casDigest, 'casDigest');

      return this.#inWriteTransaction(lease, now => {
        this.#db
          .prepare(
            `INSERT INTO scratchpad_snapshots (
              snapshot_id, campaign_id, generation, cas_digest_hex, byte_length,
              cas_rel_path, top_gains_count, failure_patterns_count, created_at_wall_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          )
          .run(
            input.snapshotId,
            input.campaignId,
            input.generation,
            input.casDigest.hex,
            input.byteLength,
            input.casRelPath,
            input.topGainsCount,
            input.failurePatternsCount,
            now.wallMs,
          );
        const row = this.#db
          .prepare('SELECT * FROM scratchpad_snapshots WHERE snapshot_id = ?;')
          .get(input.snapshotId) as SqlRow;
        return this.#hydrateScratchpadRow(row);
      });
    });
  }

  #hydrateScratchpadRow(row: SqlRow): ScratchpadSnapshotRecord {
    const out = createNullRecord<{
      snapshotId: string;
      campaignId: string;
      generation: number;
      casDigest: Digest;
      byteLength: number;
      casRelPath: string;
      topGainsCount: number;
      failurePatternsCount: number;
      createdAtWallMs: number;
    }>();
    out.snapshotId = String(row['snapshot_id']);
    out.campaignId = String(row['campaign_id']);
    out.generation = Number(row['generation']);
    out.casDigest = digestFromHex(String(row['cas_digest_hex']));
    out.byteLength = Number(row['byte_length']);
    out.casRelPath = String(row['cas_rel_path']);
    out.topGainsCount = Number(row['top_gains_count']);
    out.failurePatternsCount = Number(row['failure_patterns_count']);
    out.createdAtWallMs = Number(row['created_at_wall_ms']);
    return out;
  }

  getLatestScratchpadSnapshot(campaignId: string): Promise<ScratchpadSnapshotRecord | null> {
    return this.enqueue(() => {
      const row = this.#db
        .prepare(
          `SELECT * FROM scratchpad_snapshots
           WHERE campaign_id = ?
           ORDER BY generation DESC, created_at_wall_ms DESC, snapshot_id DESC
           LIMIT 1;`,
        )
        .get(campaignId) as SqlRow | undefined;
      return row ? this.#hydrateScratchpadRow(row) : null;
    });
  }

  listScratchpadSnapshots(campaignId: string): Promise<readonly ScratchpadSnapshotRecord[]> {
    return this.enqueue(() => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM scratchpad_snapshots
           WHERE campaign_id = ?
           ORDER BY generation ASC, created_at_wall_ms ASC, snapshot_id ASC;`,
        )
        .all(campaignId) as SqlRow[];
      return rows.map(r => this.#hydrateScratchpadRow(r));
    });
  }

  close(): Promise<void> {
    const closing = this.#queue.then(() => {
      if (!this.#closed) {
        this.#closed = true;
        this.#db.close();
      }
    });
    this.#queue = closing.then(
      () => undefined,
      () => undefined,
    );
    return closing;
  }
}

function compareNicheEliteBetter(a: IndividualRecord, b: IndividualRecord): number {
  if (a.status !== b.status) {
    if (a.status === 'passed') return -1;
    if (b.status === 'passed') return 1;
  }
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
