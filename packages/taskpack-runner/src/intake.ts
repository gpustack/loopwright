import { createHash } from 'node:crypto';
import { verifyFrozenCorpus } from './corpus.js';
import { PythonBridge } from './python-bridge.js';
import { RunnerTaskpackError } from './types.js';

/** Runner's guidance contract constants, matching the frozen orchestrator's published values (frozen `run.py` applies
 * them to Dockerfile recipe guidance; fail-closed rejection of whole `/auto-sync` comments is Loopwright's
 * intentional intake hardening on top of the same values). */
export const GUIDANCE_MAX_LINES = 40;
export const GUIDANCE_MAX_BYTES = 2048;
export const GUIDANCE_SENTINEL = /=== .*? ===/;
export const GUIDANCE_CONTRACT_PREFIXES = ['REQUIRED:', 'NEVER:'] as const;
export const JOB_LOG_LIMIT = 4000;
export const PACK_RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([0-9]+)(?:\/job\/([0-9]+))?\/?$/;
export const AUTHORIZED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

const DISCOVERY_DRIVER = `import json, sys
from pathlib import Path
config = json.loads(sys.stdin.read())
sys.path.insert(0, config["vendorRoot"])
from tools.auto_sync.discovery import discover
results = discover(Path(config["repository"]), config["releases"], config["ascendPairs"])
print(json.dumps({"results": results}))`;

/** Frozen target repository snapshot binding intake to an exact default and head revision. */
export interface RunnerIdentitySnapshot {
  readonly repository: string;
  readonly defaultSha: string;
  readonly headSha: string;
}

/** Per-upstream acquisition outcome recorded before discovery runs; failures must stay visible. */
export interface UpstreamAcquisition {
  readonly upstream: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** Complete GitHub release arrays and sourced Ascend pairs supplied independently of any proposal. */
export interface DiscoveryTables {
  readonly releases: Readonly<Record<string, readonly unknown[]>>;
  readonly ascendPairs: Readonly<Record<string, unknown>>;
}

export interface DiscoverIntakeInput extends RunnerIdentitySnapshot {
  readonly mode: 'discover';
  readonly tables: DiscoveryTables;
  readonly acquisition: readonly UpstreamAcquisition[];
  /** An already-open managed PR that exactly matches the discovered state makes the run a no-op. */
  readonly managedPrMatchesDiscoveredState?: boolean;
  readonly enginePrereleases?: readonly string[];
  readonly prereleasePackages?: readonly string[];
}

export interface ReviseIntakeInput extends RunnerIdentitySnapshot {
  readonly mode: 'revise';
  readonly prNumber: number;
  readonly commandId: number;
  readonly commenterLogin: string;
  readonly authorAssociation: string;
  readonly operatorCollaboratorAllowlist?: readonly string[];
  readonly guidance: string;
}

export interface PackRunUrlIntakeInput {
  readonly mode: 'pack-run-url';
  readonly identityRepository: string;
  readonly url: string;
  readonly jobLogText: string;
}

export type RunnerIntakeInput = DiscoverIntakeInput | ReviseIntakeInput | PackRunUrlIntakeInput;

export interface RunnerDiscoveryResult {
  readonly subscription: string;
  readonly status: string;
  readonly reason?: string;
}

export interface RunnerReviseBinding {
  readonly repository: string;
  readonly default_sha: string;
  readonly head_sha: string;
  readonly mode: 'revise';
  readonly pr_number: number;
  readonly command_id: number;
  readonly command_digest: string;
}

export interface RunnerPackRunDiagnostic {
  readonly url: string;
  readonly repository: string;
  readonly runId: string;
  readonly jobId: string | null;
  readonly jobLogText: string;
  readonly truncated: boolean;
}

export type RunnerIntakeOutcome =
  | { readonly kind: 'discovery'; readonly disposition: 'ready'; readonly identity: RunnerIdentitySnapshot; readonly results: readonly RunnerDiscoveryResult[]; readonly prereleases: { readonly engine: readonly string[]; readonly packages: readonly string[] } }
  | { readonly kind: 'discovery'; readonly disposition: 'no_change'; readonly reason: string }
  | { readonly kind: 'discovery'; readonly disposition: 'blocked'; readonly reason: 'upstream_unavailable'; readonly subscriptionErrors: readonly { readonly upstream: string; readonly error: string }[] }
  | { readonly kind: 'revise'; readonly disposition: 'ready'; readonly binding: RunnerReviseBinding }
  | { readonly kind: 'revise'; readonly disposition: 'blocked'; readonly reason: 'unauthorized_commenter' | 'invalid_guidance'; readonly detail: string }
  | { readonly kind: 'pack-run-url'; readonly disposition: 'ready'; readonly diagnostic: RunnerPackRunDiagnostic }
  | { readonly kind: 'pack-run-url'; readonly disposition: 'blocked'; readonly reason: 'invalid_pack_run_url' | 'unknown_repository_url'; readonly detail: string };

/** Runner's exact guidance bounds: line count, UTF-8 byte budget, prompt sentinels, and contract overrides. */
export function validateGuidance(body: string): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const lines = body.split('\n');
  if (lines.length > GUIDANCE_MAX_LINES) return { ok: false, detail: `guidance exceeds ${GUIDANCE_MAX_LINES} lines (${lines.length})` };
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > GUIDANCE_MAX_BYTES) return { ok: false, detail: `guidance exceeds ${GUIDANCE_MAX_BYTES} bytes (${bytes})` };
  if (GUIDANCE_SENTINEL.test(body)) return { ok: false, detail: 'guidance contains a prompt sentinel' };
  const prefix = lines.find(line => GUIDANCE_CONTRACT_PREFIXES.some(prefix => line.startsWith(prefix)));
  if (prefix !== undefined) return { ok: false, detail: 'guidance contains a contract override prefix' };
  return { ok: true };
}

/** Only established collaborators (or explicitly allowlisted operators) may command a revision. */
export function authorizeCommenter(authorAssociation: string, login: string, allowlist?: readonly string[]): boolean {
  return (AUTHORIZED_ASSOCIATIONS as readonly string[]).includes(authorAssociation) || (allowlist ?? []).includes(login);
}

/** Parse a managed-repository Actions run URL; cross-repository URLs are rejected before any log is read. */
export function parsePackRunUrl(url: string, identityRepository: string): { readonly ok: true; readonly repository: string; readonly runId: string; readonly jobId: string | null } | { readonly ok: false; readonly reason: 'invalid_pack_run_url' | 'unknown_repository_url'; readonly detail: string } {
  const match = PACK_RUN_URL_PATTERN.exec(url.trim());
  if (match === null) return { ok: false, reason: 'invalid_pack_run_url', detail: 'url is not a GitHub Actions run or job URL' };
  const repository = match[1]!, runId = match[2]!, jobId = match[3] ?? null;
  if (repository !== identityRepository) return { ok: false, reason: 'unknown_repository_url', detail: `url repository ${repository} differs from managed identity ${identityRepository}` };
  return { ok: true, repository, runId, jobId };
}

/** Keep the diagnostic tail (the frozen orchestrator keeps `log[-4000:]`), strip every sentinel, and re-bound. */
export function boundJobLog(text: string): { readonly jobLogText: string; readonly truncated: boolean } {
  const tail = text.length > JOB_LOG_LIMIT ? text.slice(-JOB_LOG_LIMIT) : text;
  const globalSentinel = new RegExp(GUIDANCE_SENTINEL.source, 'g');
  const sanitized = tail.replace(globalSentinel, '[sentinel removed]');
  const bounded = sanitized.length > JOB_LOG_LIMIT ? sanitized.slice(-JOB_LOG_LIMIT) : sanitized;
  return { jobLogText: bounded, truncated: text.length > JOB_LOG_LIMIT };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compile a frozen Runner trigger into a typed intake disposition.
 * Discovery executes the vendored frozen `discover` through the contained bridge; revise and
 * pack-run-url preparation are pure guard evaluation over the mirrored contract constants.
 */
export async function prepareRunnerIntake(input: RunnerIntakeInput, context: { readonly bridge: PythonBridge; readonly corpusRoot?: string }): Promise<RunnerIntakeOutcome> {
  if (input.mode === 'revise') {
    if (!authorizeCommenter(input.authorAssociation, input.commenterLogin, input.operatorCollaboratorAllowlist)) {
      return { kind: 'revise', disposition: 'blocked', reason: 'unauthorized_commenter', detail: `commenter ${input.commenterLogin} lacks write access (${input.authorAssociation})` };
    }
    const guidance = validateGuidance(input.guidance);
    if (!guidance.ok) return { kind: 'revise', disposition: 'blocked', reason: 'invalid_guidance', detail: guidance.detail };
    return {
      kind: 'revise',
      disposition: 'ready',
      binding: {
        repository: input.repository, default_sha: input.defaultSha, head_sha: input.headSha, mode: 'revise',
        pr_number: input.prNumber, command_id: input.commandId, command_digest: sha256Hex(input.guidance),
      },
    };
  }
  if (input.mode === 'pack-run-url') {
    const parsed = parsePackRunUrl(input.url, input.identityRepository);
    if (!parsed.ok) return { kind: 'pack-run-url', disposition: 'blocked', reason: parsed.reason, detail: parsed.detail };
    const bounded = boundJobLog(input.jobLogText);
    return {
      kind: 'pack-run-url',
      disposition: 'ready',
      diagnostic: { url: input.url, repository: parsed.repository, runId: parsed.runId, jobId: parsed.jobId, jobLogText: bounded.jobLogText, truncated: bounded.truncated },
    };
  }
  const verification = await verifyFrozenCorpus(context.corpusRoot);
  const failedFeeds = input.acquisition.filter(feed => !feed.ok);
  const outcome = await context.bridge.run(DISCOVERY_DRIVER, {
    timeoutMs: 120000,
    stdin: JSON.stringify({ vendorRoot: verification.root, repository: input.repository, releases: input.tables.releases, ascendPairs: input.tables.ascendPairs }),
  });
  if (outcome.exitCode !== 0) throw new RunnerTaskpackError('PYTHON_BOUNDARY', `frozen discovery driver exited ${outcome.exitCode}: ${outcome.stderr.slice(0, 256)}`);
  let parsed: { results?: unknown };
  try { parsed = JSON.parse(outcome.stdout) as typeof parsed; } catch { throw new RunnerTaskpackError('PYTHON_BOUNDARY', 'frozen discovery driver produced unreadable output'); }
  if (!Array.isArray(parsed.results)) throw new RunnerTaskpackError('PYTHON_BOUNDARY', 'frozen discovery driver omitted results');
  const results = parsed.results as RunnerDiscoveryResult[];
  const updates = results.filter(result => result.status === 'needs_update');
  const discoveryFailures = results.filter(result => result.status === 'failed' || result.status === 'blocked');
  if (updates.length === 0 && (failedFeeds.length > 0 || discoveryFailures.length > 0)) {
    return {
      kind: 'discovery',
      disposition: 'blocked',
      reason: 'upstream_unavailable',
      subscriptionErrors: [
        ...failedFeeds.map(feed => ({ upstream: feed.upstream, error: feed.error ?? 'acquisition failed' })),
        ...discoveryFailures.map(row => ({ upstream: row.subscription, error: row.reason ?? `discovery row status ${row.status}` })),
      ],
    };
  }
  if (updates.length === 0 || input.managedPrMatchesDiscoveredState === true) {
    return { kind: 'discovery', disposition: 'no_change', reason: updates.length === 0 ? 'no subscription reports an available update' : 'an open managed pull request already matches the discovered state' };
  }
  return {
    kind: 'discovery',
    disposition: 'ready',
    identity: { repository: input.repository, defaultSha: input.defaultSha, headSha: input.headSha },
    results,
    prereleases: { engine: input.enginePrereleases ?? [], packages: input.prereleasePackages ?? [] },
  };
}
