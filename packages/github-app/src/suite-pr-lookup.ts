import {
  authorizeRepositoryActor,
  COMMIT_SHA_PATTERN,
  DEFAULT_COMMENT_PREFIXES,
  fetchBoundedText,
  isPlainRecord,
  matchSuitePullRequestDomain,
  parseSuiteCommentCommand,
  REPOSITORY_FULL_NAME_PATTERN,
  SecretScrubber,
  TASKPACK_COMMENT_COMMANDS,
  validateCommentGuidance,
  type LoadedTaskpackSuite,
  type LoadedTaskpackSuiteDomain,
  type ParsedSuiteCommentCommand,
  type TaskpackCommentCommand,
} from '@loopwright/taskpack';
import { GitHubAppError, type GitHubAppErrorCode } from './types.js';

export const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com' as const;

/**
 * Validate and normalize a GitHub REST API base URL (`https://` or loopback `http://127.0.0.1`,
 * `http://localhost`, `http://[::1]`), defaulting omitted/empty values to `https://api.github.com`.
 */
export function validateGitHubApiBaseUrl(
  rawUrl: string | undefined,
  errorCode: GitHubAppErrorCode = 'ACTION_INPUT_INVALID',
  path: string | null = '/apiBaseUrl',
): string {
  const candidate = rawUrl?.trim() ? rawUrl.trim() : DEFAULT_GITHUB_API_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new GitHubAppError(errorCode, 'apiBaseUrl must be a valid URL', path);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new GitHubAppError(errorCode, 'apiBaseUrl must not embed credentials or URL fragments', path);
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1'
    || host === 'localhost'
    || host === '[::1]'
    || host === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new GitHubAppError(
      errorCode,
      'apiBaseUrl must use https:// (or loopback http:// for local tests)',
      path,
    );
  }
  return candidate.replace(/\/+$/, '');
}

export interface VerifySuiteCommentPullRequestOptions {
  readonly suite: LoadedTaskpackSuite;
  readonly eventName: string;
  readonly eventPayload: unknown;
  readonly repositoryFullName: string;
  readonly apiBaseUrl?: string | undefined;
  readonly explicitDomain?: string | undefined;
  readonly resolveToken?: (() => Promise<string | undefined> | string | undefined) | undefined;
  readonly commentPrefixes?: readonly string[] | undefined;
  readonly commentCommands?: readonly TaskpackCommentCommand[] | undefined;
  readonly operatorAllowlist?: readonly string[] | undefined;
  readonly fetchImpl?: typeof globalThis.fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly scrubber: SecretScrubber;
}

export interface VerifiedSuitePullRequestOwnership {
  readonly domain: LoadedTaskpackSuiteDomain;
  readonly comment: ParsedSuiteCommentCommand;
  readonly prNumber?: number | undefined;
  readonly prHeadRef: string;
  readonly prBaseRef: string;
  readonly prHeadSha: string;
  readonly prBaseSha?: string | undefined;
  readonly login: string;
  readonly authorAssociation: string;
  readonly commandId: number;
}

export type SuiteCommentPullRequestVerification =
  | {
    readonly kind: 'ignored';
    readonly reason: string;
  }
  | {
    readonly kind: 'missing_attribution';
    readonly code: 'WEBHOOK_ACTOR_UNAUTHORIZED';
    readonly reason: 'unauthorized_actor';
    readonly detail: string;
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'unauthorized';
    readonly code: 'WEBHOOK_ACTOR_UNAUTHORIZED';
    readonly reason: 'unauthorized_actor';
    readonly detail: string;
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'invalid_guidance';
    readonly code: 'WEBHOOK_GUIDANCE_INVALID';
    readonly reason: 'invalid_guidance';
    readonly detail: string;
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'lookup_failed';
    readonly code: 'ACTION_INPUT_INVALID';
    readonly reason: 'pull_request_metadata_unavailable';
    readonly detail: string;
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'metadata_unavailable';
    readonly code: 'ACTION_INPUT_INVALID';
    readonly reason: 'pull_request_metadata_unavailable';
    readonly detail: string;
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'cross_fork';
    readonly code: 'TASKPACK_SCOPE_VIOLATION';
    readonly reason: 'cross_fork_pull_request';
    readonly detail: 'cross-fork pull request comments are refused';
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'scope_violation';
    readonly code: 'TASKPACK_SCOPE_VIOLATION';
    readonly reason: string;
    readonly detail: string;
    readonly comment: ParsedSuiteCommentCommand;
  }
  | {
    readonly kind: 'verified';
    readonly value: VerifiedSuitePullRequestOwnership;
  };

function readNonEmptyString(record: Record<string, unknown> | null, field: string): string | null {
  if (record === null) return null;
  const val = record[field];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Shared pull-request comment attribution, command parsing, authenticated GitHub REST PR lookup,
 * cross-fork refusal, and `(targetBranch, headBranchPrefix)` domain ownership verification used by
 * both `runGitHubActionEntrypoint` (`action.ts`) and `startGitHubAppControlPlane` (`service.ts`).
 */
export async function verifySuiteCommentPullRequest(
  options: VerifySuiteCommentPullRequestOptions,
): Promise<SuiteCommentPullRequestVerification> {
  const isPullRequestReview = options.eventName === 'pull_request_review';
  if (!isPlainRecord(options.eventPayload)) {
    return { kind: 'ignored', reason: 'event payload is not a JSON object' };
  }
  const payload = options.eventPayload;
  const payloadAction = typeof payload['action'] === 'string' ? payload['action'] : '';
  const expectedAction = isPullRequestReview ? 'submitted' : 'created';
  if (payloadAction !== expectedAction) {
    return { kind: 'ignored', reason: `${options.eventName} action ${payloadAction} is not ${expectedAction}` };
  }

  const issueObj = isPlainRecord(payload['issue']) ? payload['issue'] : null;
  const issuePrObj = issueObj !== null && isPlainRecord(issueObj['pull_request']) ? issueObj['pull_request'] : null;
  const topPrObj = isPlainRecord(payload['pull_request']) ? payload['pull_request'] : null;
  if (!isPullRequestReview && issuePrObj === null && topPrObj === null) {
    return { kind: 'ignored', reason: 'comment is not on a pull request' };
  }

  const container = isPullRequestReview
    ? (isPlainRecord(payload['review']) ? payload['review'] : null)
    : (isPlainRecord(payload['comment']) ? payload['comment'] : null);
  if (container === null) {
    return { kind: 'ignored', reason: 'comment payload is unreadable' };
  }

  const userObj = isPlainRecord(container['user']) ? container['user'] : null;
  const body = typeof container['body'] === 'string' ? container['body'] : null;
  const login = readNonEmptyString(userObj, 'login');
  const association = readNonEmptyString(container, 'author_association');
  const userType = readNonEmptyString(userObj, 'type');
  if (userType === 'Bot' || (login !== null && login.toLowerCase().endsWith('[bot]'))) {
    return { kind: 'ignored', reason: 'comment author is a bot' };
  }
  if (body === null || body.trim().length === 0) {
    return { kind: 'ignored', reason: 'comment without a configured command prefix' };
  }

  const validDomainIds = options.suite.domains.map(d => d.id);
  const unionPrefixes = options.commentPrefixes !== undefined
    ? [...options.commentPrefixes]
    : [
      ...new Set([
        ...DEFAULT_COMMENT_PREFIXES,
        ...options.suite.domains.flatMap(d => d.manifest.spec.triggers.commentPrefixes),
      ]),
    ];
  const allowedCommands: readonly TaskpackCommentCommand[] = options.commentCommands ?? TASKPACK_COMMENT_COMMANDS;
  const parsedCmd = parseSuiteCommentCommand(
    body,
    unionPrefixes,
    allowedCommands,
    new Set(validDomainIds),
  );
  if (parsedCmd === null) {
    return { kind: 'ignored', reason: 'comment without a configured command prefix' };
  }
  if (login === null || association === null) {
    return {
      kind: 'missing_attribution',
      code: 'WEBHOOK_ACTOR_UNAUTHORIZED',
      reason: 'unauthorized_actor',
      detail: 'event payload is missing comment attribution',
      comment: parsedCmd,
    };
  }

  if (!authorizeRepositoryActor(association, login, options.operatorAllowlist)) {
    return {
      kind: 'unauthorized',
      code: 'WEBHOOK_ACTOR_UNAUTHORIZED',
      reason: 'unauthorized_actor',
      detail: `actor ${login} lacks write access (${association})`,
      comment: parsedCmd,
    };
  }

  const guidanceCheck = validateCommentGuidance(parsedCmd.guidance);
  if (!guidanceCheck.ok) {
    return {
      kind: 'invalid_guidance',
      code: 'WEBHOOK_GUIDANCE_INVALID',
      reason: 'invalid_guidance',
      detail: guidanceCheck.detail,
      comment: parsedCmd,
    };
  }

  const validatedApiBaseUrl = validateGitHubApiBaseUrl(options.apiBaseUrl);

  const prSource = topPrObj ?? issuePrObj;
  const rawHead = prSource !== null && isPlainRecord(prSource['head']) ? prSource['head'] : null;
  const rawBase = prSource !== null && isPlainRecord(prSource['base']) ? prSource['base'] : null;
  const rawHeadRepo = rawHead !== null && isPlainRecord(rawHead['repo']) ? rawHead['repo'] : null;
  const rawBaseRepo = rawBase !== null && isPlainRecord(rawBase['repo']) ? rawBase['repo'] : null;

  let prHeadRepoNull = rawHead !== null && rawHead['repo'] === null;
  let prHeadRef = readNonEmptyString(rawHead, 'ref') ?? undefined;
  let prBaseRef = readNonEmptyString(rawBase, 'ref') ?? undefined;
  let prHeadSha = readNonEmptyString(rawHead, 'sha') ?? undefined;
  let prBaseSha = readNonEmptyString(rawBase, 'sha') ?? undefined;
  let prHeadRepoFullName = readNonEmptyString(rawHeadRepo, 'full_name') ?? undefined;
  let prHeadRepoFork: boolean | undefined;
  if (typeof rawHeadRepo?.['fork'] === 'boolean') {
    const sameForkRepo = rawBaseRepo !== null
      && rawBaseRepo['fork'] === true
      && typeof rawHeadRepo['id'] === 'number'
      && rawHeadRepo['id'] === rawBaseRepo['id'];
    prHeadRepoFork = sameForkRepo ? false : rawHeadRepo['fork'];
  }

  const prNumber = typeof topPrObj?.['number'] === 'number' && Number.isSafeInteger(topPrObj['number']) && topPrObj['number'] > 0
    ? topPrObj['number']
    : (typeof issueObj?.['number'] === 'number' && Number.isSafeInteger(issueObj['number']) && issueObj['number'] > 0
      ? issueObj['number']
      : undefined);

  const needsPrLookup = !prHeadRepoNull
    && (
      prHeadRef === undefined
      || prBaseRef === undefined
      || prHeadSha === undefined
      || !COMMIT_SHA_PATTERN.test(prHeadSha.trim())
      || (parsedCmd.command !== 'status' && (prBaseSha === undefined || !COMMIT_SHA_PATTERN.test(prBaseSha.trim())))
      || prHeadRepoFullName === undefined
    );

  if (needsPrLookup) {
    if (prNumber === undefined || !REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)) {
      return {
        kind: 'metadata_unavailable',
        code: 'ACTION_INPUT_INVALID',
        reason: 'pull_request_metadata_unavailable',
        detail: options.scrubber.scrub(
          `pull_request_metadata_unavailable: pull request metadata is missing and cannot be queried for "${options.repositoryFullName}"`,
        ),
        comment: parsedCmd,
      };
    }

    try {
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'loopwright-github-app',
      };
      const resolvedToken = (await options.resolveToken?.())?.trim();
      if (resolvedToken !== undefined && resolvedToken.length > 0) {
        options.scrubber.register(resolvedToken);
        headers['authorization'] = `Bearer ${resolvedToken}`;
      }
      const prRes = await fetchBoundedText(
        `${validatedApiBaseUrl}/repos/${options.repositoryFullName}/pulls/${prNumber}`,
        options.fetchImpl ?? globalThis.fetch,
        headers,
        options.timeoutMs ?? 15_000,
        options.scrubber,
      );
      if (!prRes.ok) {
        return {
          kind: 'lookup_failed',
          code: 'ACTION_INPUT_INVALID',
          reason: 'pull_request_metadata_unavailable',
          detail: options.scrubber.scrub(
            `pull_request_metadata_unavailable: pull request #${prNumber} lookup failed with HTTP ${prRes.status}`,
          ),
          comment: parsedCmd,
        };
      }
      let prData: unknown;
      try {
        prData = JSON.parse(prRes.text) as unknown;
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return {
          kind: 'lookup_failed',
          code: 'ACTION_INPUT_INVALID',
          reason: 'pull_request_metadata_unavailable',
          detail: options.scrubber.scrub(
            `pull_request_metadata_unavailable: pull request #${prNumber} returned invalid JSON (${msg})`,
          ),
          comment: parsedCmd,
        };
      }
      if (!isPlainRecord(prData)) {
        return {
          kind: 'lookup_failed',
          code: 'ACTION_INPUT_INVALID',
          reason: 'pull_request_metadata_unavailable',
          detail: options.scrubber.scrub(
            `pull_request_metadata_unavailable: pull request #${prNumber} returned non-object JSON`,
          ),
          comment: parsedCmd,
        };
      }

      const fHead = isPlainRecord(prData['head']) ? prData['head'] : null;
      const fBase = isPlainRecord(prData['base']) ? prData['base'] : null;
      const fHeadRepo = fHead !== null && isPlainRecord(fHead['repo']) ? fHead['repo'] : null;
      const fBaseRepo = fBase !== null && isPlainRecord(fBase['repo']) ? fBase['repo'] : null;
      if (fHead !== null && fHead['repo'] === null) prHeadRepoNull = true;
      prHeadRef ??= readNonEmptyString(fHead, 'ref') ?? undefined;
      prBaseRef ??= readNonEmptyString(fBase, 'ref') ?? undefined;
      if (prHeadSha === undefined || !COMMIT_SHA_PATTERN.test(prHeadSha.trim())) {
        prHeadSha = readNonEmptyString(fHead, 'sha') ?? prHeadSha;
      }
      if (prBaseSha === undefined || !COMMIT_SHA_PATTERN.test(prBaseSha.trim())) {
        prBaseSha = readNonEmptyString(fBase, 'sha') ?? prBaseSha;
      }
      prHeadRepoFullName ??= readNonEmptyString(fHeadRepo, 'full_name') ?? undefined;
      if (typeof fHeadRepo?.['fork'] === 'boolean') {
        const sameForkRepo = fBaseRepo !== null
          && fBaseRepo['fork'] === true
          && typeof fHeadRepo['id'] === 'number'
          && fHeadRepo['id'] === fBaseRepo['id'];
        prHeadRepoFork ??= sameForkRepo ? false : fHeadRepo['fork'];
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        kind: 'lookup_failed',
        code: 'ACTION_INPUT_INVALID',
        reason: 'pull_request_metadata_unavailable',
        detail: options.scrubber.scrub(
          `pull_request_metadata_unavailable: pull request #${prNumber} lookup error (${msg})`,
        ),
        comment: parsedCmd,
      };
    }
  }

  // 1. Refuse actual cross-fork pull requests (`head.repo === null`, `fork: true`, or mismatched `head.repo.full_name`).
  const isCrossFork = prHeadRepoNull
    || prHeadRepoFork === true
    || (
      prHeadRepoFullName !== undefined
      && prHeadRepoFullName.trim().length > 0
      && (
        !REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)
        || prHeadRepoFullName.trim().toLowerCase() !== options.repositoryFullName.trim().toLowerCase()
      )
    );
  if (isCrossFork) {
    return {
      kind: 'cross_fork',
      code: 'TASKPACK_SCOPE_VIOLATION',
      reason: 'cross_fork_pull_request',
      detail: 'cross-fork pull request comments are refused',
      comment: parsedCmd,
    };
  }

  // 2. Refuse missing or malformed PR repository/branch/SHA metadata with distinct `pull_request_metadata_unavailable`.
  if (
    prHeadRepoFullName === undefined
    || prHeadRepoFullName.trim().length === 0
    || !REPOSITORY_FULL_NAME_PATTERN.test(options.repositoryFullName)
    || prBaseRef === undefined
    || prBaseRef.trim().length === 0
    || prHeadRef === undefined
    || prHeadRef.trim().length === 0
  ) {
    return {
      kind: 'metadata_unavailable',
      code: 'ACTION_INPUT_INVALID',
      reason: 'pull_request_metadata_unavailable',
      detail: options.scrubber.scrub(
        `pull_request_metadata_unavailable: pull request head/base branch metadata is unavailable; valid domains: ${validDomainIds.join(', ')}`,
      ),
      comment: parsedCmd,
    };
  }
  if (prHeadSha === undefined || !COMMIT_SHA_PATTERN.test(prHeadSha.trim())) {
    return {
      kind: 'metadata_unavailable',
      code: 'ACTION_INPUT_INVALID',
      reason: 'pull_request_metadata_unavailable',
      detail: 'pull_request_metadata_unavailable: pull request head.sha must be a verified 40-hex commit SHA',
      comment: parsedCmd,
    };
  }

  const trimmedHeadRef = prHeadRef.trim();
  const trimmedBaseRef = prBaseRef.trim();
  const normalizedHeadSha = prHeadSha.trim().toLowerCase();
  const normalizedBaseSha = prBaseSha !== undefined && COMMIT_SHA_PATTERN.test(prBaseSha.trim())
    ? prBaseSha.trim().toLowerCase()
    : undefined;
  if (parsedCmd.command !== 'status' && normalizedBaseSha === undefined) {
    return {
      kind: 'metadata_unavailable',
      code: 'ACTION_INPUT_INVALID',
      reason: 'pull_request_metadata_unavailable',
      detail: 'pull_request_metadata_unavailable: pull request base.sha must be a verified 40-hex commit SHA',
      comment: parsedCmd,
    };
  }

  // 3. Verify `(targetBranch, headBranchPrefix)` domain ownership and explicit `<domainId>` consistency.
  const domainById = new Map<string, LoadedTaskpackSuiteDomain>(options.suite.domains.map(d => [d.id, d]));
  const ownership = matchSuitePullRequestDomain(options.suite.domains, trimmedHeadRef, trimmedBaseRef);
  if (ownership.ambiguous) {
    return {
      kind: 'scope_violation',
      code: 'TASKPACK_SCOPE_VIOLATION',
      reason: 'ambiguous_pull_request_branch',
      detail: `pull request branch "${trimmedHeadRef}" is ambiguous; valid domains: ${validDomainIds.join(', ')}`,
      comment: parsedCmd,
    };
  }

  if (parsedCmd.domainId !== undefined) {
    const explicitTarget = domainById.get(parsedCmd.domainId);
    if (explicitTarget === undefined) {
      return {
        kind: 'scope_violation',
        code: 'TASKPACK_SCOPE_VIOLATION',
        reason: 'unknown_domain',
        detail: `unknown suite domain "${parsedCmd.domainId}"; valid domains: ${validDomainIds.join(', ')}`,
        comment: parsedCmd,
      };
    }
    if (ownership.matched === null || ownership.matched.id !== explicitTarget.id) {
      return {
        kind: 'scope_violation',
        code: 'TASKPACK_SCOPE_VIOLATION',
        reason: 'domain_branch_mismatch',
        detail: ownership.matched !== null
          ? `comment targets domain "${explicitTarget.id}" on pull request branch "${trimmedHeadRef}" owned by domain "${ownership.matched.id}"`
          : `comment targets domain "${explicitTarget.id}" on unmanaged pull request branch "${trimmedHeadRef}"; valid domains: ${validDomainIds.join(', ')}`,
        comment: parsedCmd,
      };
    }
  }

  if (ownership.matched === null) {
    return {
      kind: 'scope_violation',
      code: 'TASKPACK_SCOPE_VIOLATION',
      reason: 'unmatched_pull_request_branch',
      detail: `pull request branch "${trimmedHeadRef}" does not match any suite domain headBranchPrefix; valid domains: ${validDomainIds.join(', ')}`,
      comment: parsedCmd,
    };
  }

  const targetDomain = ownership.matched;
  if (options.explicitDomain !== undefined && options.explicitDomain !== targetDomain.id) {
    return {
      kind: 'scope_violation',
      code: 'TASKPACK_SCOPE_VIOLATION',
      reason: 'domain_branch_mismatch',
      detail: `explicit domain "${options.explicitDomain}" conflicts with pull request branch "${trimmedHeadRef}" owned by domain "${targetDomain.id}"`,
      comment: parsedCmd,
    };
  }

  const rawId = container['id'];
  const commandId = typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0 ? rawId : 0;

  return {
    kind: 'verified',
    value: {
      domain: targetDomain,
      comment: parsedCmd,
      prNumber,
      prHeadRef: trimmedHeadRef,
      prBaseRef: trimmedBaseRef,
      prHeadSha: normalizedHeadSha,
      ...(normalizedBaseSha !== undefined ? { prBaseSha: normalizedBaseSha } : {}),
      login,
      authorAssociation: association,
      commandId,
    },
  };
}
