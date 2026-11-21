import {
  checkManagedPrMatchesDiscoveredState as taskpackCheckManagedPrMatchesDiscoveredState,
  discoverTaskpackUpstreams as taskpackDiscoverTaskpackUpstreams,
  discoverTaskpackUpstreamsV2 as taskpackDiscoverTaskpackUpstreamsV2,
  findOpenManagedPullRequest as taskpackFindOpenManagedPullRequest,
  findOpenMemoryPullRequest as taskpackFindOpenMemoryPullRequest,
  resolveGitHubAuth as taskpackResolveGitHubAuth,
  resolveGitHubToken as taskpackResolveGitHubToken,
  resolveRepositoryAndRevisions as taskpackResolveRepositoryAndRevisions,
  type CheckManagedPrMatchesOptions,
  type DiscoverTaskpackUpstreamsOptions,
  type DiscoverTaskpackUpstreamsV2Result,
  type FindOpenManagedPullRequestOptions,
  type FindOpenMemoryPullRequestOptions,
  type ManagedPullRequestInfo,
  type ResolveActionGitHubAuthOptions,
  type ResolveActionGitHubTokenOptions,
  type ResolvedActionGitHubAuth,
  type ResolvedRepositoryAndRevisions,
  type ResolveRepositoryAndRevisionsOptions,
  type TaskpackManifest,
  type TaskpackV2Manifest,
  type UpstreamAcquisitionRecord,
} from '@loopwright/taskpack';
import { createGitHubAppJwt } from './token-broker.js';

export {
  applyUpstreamGroups,
  assertNoSymlinkSegments,
  attachUpstreamContext,
  buildCleanGitEnv,
  buildUpstreamMemoryVersions,
  COMMIT_SHA_PATTERN,
  compareStrictSemver,
  compareVersionTags,
  DEFAULT_GIT_COMMIT_IDENTITY,
  evaluateUpstreamIntakeDisposition,
  extractJsonVersionPath,
  fetchBoundedText,
  formatUpstreamSummary,
  isPlainRecord,
  isPrereleaseVersionTag,
  loadRepositoryBaselineVersions,
  MEMORY_PULL_REQUEST_BRANCH_PREFIX,
  normalizeHeldBackVersions,
  parseOptionalGitIdentityInput,
  parseUpstreamRecordsJson,
  resolveGitCommitSha,
  resolveGitExecutable,
  shouldPreserveExplicitSourceRevision,
  validateGitAuthorEmail,
  validateGitAuthorName,
  validateGitCommitIdentity,
  validateGitRemoteSource,
  type CheckManagedPrMatchesOptions,
  type DiscoverTaskpackUpstreamsOptions,
  type DiscoverTaskpackUpstreamsV2Result,
  type FindOpenManagedPullRequestOptions,
  type FindOpenMemoryPullRequestOptions,
  type ManagedPullRequestInfo,
  type ResolveActionGitHubAuthOptions,
  type ResolveActionGitHubTokenOptions,
  type ResolvedActionGitHubAuth,
  type ResolvedRepositoryAndRevisions,
  type ResolveRepositoryAndRevisionsOptions,
  type UpstreamAcquisitionRecord,
  type UpstreamHeadersResolver,
  type UpstreamIntakeDisposition,
  type UpstreamIntakeDispositionResult,
  type UpstreamTokenResolver,
} from '@loopwright/taskpack';

function withGitHubAppUserAgent(fetchImpl?: typeof globalThis.fetch): typeof globalThis.fetch {
  const base = fetchImpl ?? globalThis.fetch;
  return (input, init) => {
    if (init?.headers !== undefined && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
      const record = init.headers as Record<string, string>;
      if (record['user-agent'] === 'loopwright-taskpack') {
        return base(input, { ...init, headers: { ...record, 'user-agent': 'loopwright-github-app' } });
      }
    }
    return base(input, init);
  };
}

export async function resolveGitHubAuth(
  options: ResolveActionGitHubAuthOptions,
): Promise<ResolvedActionGitHubAuth> {
  return taskpackResolveGitHubAuth({
    ...options,
    createAppJwt: options.createAppJwt ?? createGitHubAppJwt,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function resolveGitHubToken(
  options: ResolveActionGitHubTokenOptions,
): Promise<string | undefined> {
  return taskpackResolveGitHubToken({
    ...options,
    createAppJwt: options.createAppJwt ?? createGitHubAppJwt,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function resolveRepositoryAndRevisions(
  options: ResolveRepositoryAndRevisionsOptions,
): Promise<ResolvedRepositoryAndRevisions> {
  return taskpackResolveRepositoryAndRevisions({
    ...options,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function findOpenManagedPullRequest(
  options: FindOpenManagedPullRequestOptions,
): Promise<ManagedPullRequestInfo | null> {
  return taskpackFindOpenManagedPullRequest({
    ...options,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function findOpenMemoryPullRequest(
  options: FindOpenMemoryPullRequestOptions,
): Promise<ManagedPullRequestInfo | null> {
  return taskpackFindOpenMemoryPullRequest({
    ...options,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function discoverTaskpackUpstreams(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: DiscoverTaskpackUpstreamsOptions = {},
): Promise<readonly UpstreamAcquisitionRecord[]> {
  return taskpackDiscoverTaskpackUpstreams(manifest, {
    ...options,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function discoverTaskpackUpstreamsV2(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: DiscoverTaskpackUpstreamsOptions & {
    readonly force?: boolean | undefined;
    readonly managedPrMatchesDiscoveredState?: boolean | undefined;
  } = {},
): Promise<DiscoverTaskpackUpstreamsV2Result> {
  return taskpackDiscoverTaskpackUpstreamsV2(manifest, {
    ...options,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}

export async function checkManagedPrMatchesDiscoveredState(
  options: CheckManagedPrMatchesOptions,
): Promise<boolean> {
  return taskpackCheckManagedPrMatchesDiscoveredState({
    ...options,
    fetchImpl: withGitHubAppUserAgent(options.fetchImpl),
  });
}
