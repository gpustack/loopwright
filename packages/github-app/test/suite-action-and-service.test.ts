import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import * as githubApp from '../src/index.js';
import {
  BASELINE_ALIGNMENT_POLICIES,
  BASELINE_CONFLICT_REASON,
  BASELINE_CONFLICT_RESOURCE_ID,
  BASELINE_CONFLICT_RESOURCE_PATH,
  DEFAULT_HOST_BUDGETS,
  GitHubAppError,
  InstallationTokenBroker,
  MULTI_TENANT_HOST_POLICY,
  compileDeclarativeTaskpack,
  loadTaskpackSuite,
  parseTaskpackManifest,
  runActionCli,
  runGitHubActionEntrypoint,
  serializePrettyYaml,
  startConfiguredGitHubApp,
  startGitHubAppControlPlane,
  startNativePullRequestPublisherServer,
  type InstallationTokenRequest,
  type TenantIdentity,
} from '../src/index.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';
import { git, parseGithubOutputs, readJsonBody, sseStop, sseToolCall, startHttpServer } from './turnkey-action-fixtures.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '../../../..');
const fastAdapter = createFastTurnkeyAdapter();

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const WEBHOOK_SECRET = 'suite-webhook-secret-987654';

function signWebhook(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(body, 'utf8')).digest('hex')}`;
}

async function snapshotGitObjects(repoRoot: string): Promise<readonly string[]> {
  const objectsRoot = join(repoRoot, '.git', 'objects');
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const st = await lstat(full);
        found.push(`${relative(objectsRoot, full)}:${st.size}`);
      }
    }
  };
  await walk(objectsRoot);
  return found;
}

function makeDomainTaskpackYaml(options: {
  readonly name: string;
  readonly controlDir?: string;
  readonly writable: readonly string[];
  readonly headBranchPrefix: string;
  readonly targetBranch?: string;
  readonly instructions?: readonly string[];
  readonly proposalPath?: string;
  readonly openAiBaseUrl?: string;
  readonly baselineAlignmentPolicy?: 'off' | 'fail-fast' | 'extract-context';
  readonly allowWorkflowWrites?: boolean;
  readonly upstreams?: readonly Record<string, unknown>[];
}): string {
  const controlRoot = options.controlDir ?? `.loopwright/${options.name}`;
  return serializePrettyYaml({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: options.name },
    spec: {
      ...(options.allowWorkflowWrites === true
        ? {
          execution: {
            mode: 'strict',
            capabilities: { allowWorkflowWrites: true },
          },
        }
        : {}),
      goal: {
        candidate: `Update ${options.name} domain files cleanly.`,
        noChange: `Confirm ${options.name} needs no updates.`,
      },
      scope: {
        writable: [...options.writable],
        protected: [],
      },
      ...(options.instructions !== undefined ? { instructions: [...options.instructions] } : {}),
      ...(options.proposalPath !== undefined
        ? {
          proposal: {
            path: options.proposalPath,
            requiredFields: ['schema_version', 'version'],
            schemaVersion: 1,
          },
        }
        : {}),
      ...(options.baselineAlignmentPolicy !== undefined
        ? { baselineAlignment: { policy: options.baselineAlignmentPolicy } }
        : {}),
      ...(options.upstreams !== undefined ? { upstreams: [...options.upstreams] } : {}),
      verification: {
        localChecks: options.proposalPath !== undefined
          ? [{ id: `${options.name}-json`, implementation: 'json-artifact.v1' }]
          : [{ id: `${options.name}-scope`, implementation: 'scope.v1' }],
        externalGates: [],
      },
      publication: {
        mode: 'pull_request',
        targetBranch: options.targetBranch ?? 'main',
        headBranchPrefix: options.headBranchPrefix,
        titleTemplate: `chore(${options.name}): sync domain`,
      },
      memory: {
        directory: `${controlRoot}/memory/${options.name}`,
        apply: 'disabled',
      },
      triggers: {
        schedule: true,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: ['retry', 'revise', 'status'],
        commentPrefixes: ['/loopwright'],
      },
      ...(options.openAiBaseUrl !== undefined
        ? {
          models: [
            {
              provider: 'openai',
              id: 'gpt-4.1-mini',
              api: 'openai-completions',
              apiKeyEnv: 'LLM_TOKEN',
              baseUrl: `${options.openAiBaseUrl}/v1`,
              cost: { input: 1, output: 2 },
            },
          ],
        }
        : {}),
      output: {
        formats: ['json', 'github-step-summary'],
      },
    },
  });
}

describe('@loopwright/github-app suite Action routing, PR ownership lookup, multi-domain App, and 3-way publisher', () => {
  it('re-exports suite & baseline-alignment symbols from @loopwright/github-app and wires action.yml inputs/outputs', async () => {
    const requiredFunctions = [
      'loadTaskpackSuite',
      'resolveTaskpackSuite',
      'checkTaskpackSuite',
      'validateTaskpackSuite',
      'parseTaskpackSuiteManifest',
      'validateTaskpackSuiteManifest',
      'parseSuiteCommentCommand',
      'matchSuitePullRequestDomain',
      'readGitRevisionVersionFrom',
      'alignBaselineRevisions',
      'parseBaselineAlignmentPolicy',
      'resolveBaselineAlignmentConfig',
      'computeThreeWaySourceRevisionCarryDelta',
      'mergeCandidateOverlayWithCarry',
      'ensureCarryBlobsInGitObjectStore',
      'verifyCandidateBaselinePrePublication',
      'assertExtractedConflictsResolved',
      'containsResidualGitConflictMarkers',
    ] as const;
    for (const fnName of requiredFunctions) {
      assert.equal(
        typeof (githubApp as Record<string, unknown>)[fnName],
        'function',
        `expected @loopwright/github-app to export function ${fnName}`,
      );
    }
    assert.deepEqual(BASELINE_ALIGNMENT_POLICIES, ['off', 'fail-fast', 'extract-context']);
    assert.equal(BASELINE_CONFLICT_REASON, 'baseline_merge_conflict');
    assert.equal(BASELINE_CONFLICT_RESOURCE_ID, 'baseline-conflict-context');
    assert.equal(BASELINE_CONFLICT_RESOURCE_PATH, '.loopwright-baseline/conflicts.json');

    const actionYmlRaw = await readFile(join(REPO_ROOT, 'action.yml'), 'utf8');
    const actionDoc = parseYaml(actionYmlRaw) as {
      inputs?: Record<string, { default?: string; required?: boolean }>;
      outputs?: Record<string, { value?: string }>;
      runs?: { steps?: Array<{ id?: string; env?: Record<string, string> }> };
    };
    assert.ok(actionDoc.inputs?.['suite-path'] !== undefined);
    assert.ok(actionDoc.inputs?.['domain'] !== undefined);
    assert.equal(actionDoc.inputs?.['resolve-suite-only']?.default, 'false');
    assert.ok(actionDoc.inputs?.['baseline-alignment'] !== undefined);
    assert.equal(actionDoc.outputs?.['matrix']?.value, '${{ steps.loopwright-entrypoint.outputs.matrix }}');
    const entrypointStep = actionDoc.runs?.steps?.find(step => step.id === 'loopwright-entrypoint');
    const stepEnv = entrypointStep?.env ?? {};
    assert.equal(stepEnv['INPUT_SUITE-PATH'], '${{ inputs.suite-path }}');
    assert.equal(stepEnv['INPUT_DOMAIN'], '${{ inputs.domain }}');
    assert.equal(stepEnv['INPUT_RESOLVE-SUITE-ONLY'], '${{ inputs.resolve-suite-only }}');
    assert.equal(stepEnv['INPUT_BASELINE-ALIGNMENT'], '${{ inputs.baseline-alignment }}');
  });

  it('resolves multi-domain suite matrix in resolve-suite-only mode (Stage A PR deferral -> Stage B promotion -> fail-closed probe errors) and binds domain scope on execution', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-t9-suite-action-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');

    let stageAPrOpen = true;
    let releaseMode: 'ok_1_1_0' | 'ok_1_2_0' | 'not_found_404' | 'server_500' | 'auth_401' | 'paginate_exhaust' = 'ok_1_1_0';
    let lastAuthHeader = '';

    const githubServer = await startHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      lastAuthHeader = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';

      if (url.pathname === '/repos/acme/mono/pulls' && req.method === 'GET') {
        const list = stageAPrOpen
          ? [{
            number: 12,
            html_url: 'https://github.invalid/acme/mono/pull/12',
            title: 'chore(stage-a): bump sdk',
            state: 'open',
            base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'acme/mono', fork: false } },
            head: { ref: 'loopwright/stage-a/main', sha: 'b'.repeat(40), repo: { full_name: 'acme/mono', fork: false } },
          }]
          : [];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }

      if (url.pathname.startsWith('/repos/acme/sdk-upstream/releases') && req.method === 'GET') {
        if (releaseMode === 'not_found_404') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not Found' }));
          return;
        }
        if (releaseMode === 'server_500') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'upstream outage with secret ghp_suite_resolve_tok_123456' }));
          return;
        }
        if (releaseMode === 'auth_401') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Bad credentials' }));
          return;
        }
        if (releaseMode === 'paginate_exhaust') {
          const items = Array.from({ length: 30 }, (_, idx) => ({
            tag_name: `v0.0.${idx}-rc.1`,
            draft: false,
            prerelease: true,
          }));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(items));
          return;
        }
        const tag = releaseMode === 'ok_1_2_0' ? 'v1.2.0' : 'v1.1.0';
        const payload = url.pathname.endsWith('/latest')
          ? { tag_name: tag, draft: false, prerelease: false }
          : [{ tag_name: tag, draft: false, prerelease: false }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    try {
      await mkdir(join(repo, '.loopwright', 'stage-a'), { recursive: true });
      await mkdir(join(repo, '.loopwright', 'stage-b'), { recursive: true });
      await mkdir(join(repo, 'packages', 'sdk'), { recursive: true });
      await mkdir(join(repo, 'apps', 'web'), { recursive: true });
      await mkdir(join(repo, 'rules'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'rules', 'stage-b-guide.md'), '# Stage B Rules\n', 'utf8');
      await writeFile(join(repo, 'packages', 'sdk', 'package.json'), '{"name":"@acme/sdk","version":"1.1.0"}\n', 'utf8');
      await writeFile(join(repo, 'packages', 'sdk', 'proposal.json'), '{"schema_version":1,"version":"1.1.0"}\n', 'utf8');
      await writeFile(join(repo, 'apps', 'web', 'proposal.json'), '{"schema_version":1,"version":"1.1.0"}\n', 'utf8');

      await writeFile(
        join(repo, '.loopwright', 'stage-a', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'stage-a',
          writable: ['packages/sdk/**'],
          headBranchPrefix: 'loopwright/stage-a/',
          proposalPath: 'packages/sdk/proposal.json',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'stage-b', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'stage-b',
          writable: ['apps/web/**'],
          headBranchPrefix: 'loopwright/stage-b/',
          instructions: ['rules/stage-b-guide.md'],
          proposalPath: 'apps/web/proposal.json',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'suite.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'TaskpackSuite',
          metadata: { name: 'acme-suite' },
          spec: {
            domains: [
              {
                id: 'stage-a',
                taskpack: '.loopwright/stage-a/taskpack.yaml',
                stage: 'stage-a',
                schedules: ['0 2 * * *'],
                matrix: { runner: 'ubuntu-latest', tier: 1 },
              },
              {
                id: 'stage-b',
                taskpack: '.loopwright/stage-b/taskpack.yaml',
                stage: 'stage-b',
                schedules: ['0 2 * * *'],
                matrix: { runner: 'ubuntu-latest', tier: 2 },
              },
            ],
            stages: [
              { id: 'stage-a' },
              {
                id: 'stage-b',
                dependsOn: ['stage-a'],
                readiness: [
                  {
                    id: 'sdk-release',
                    kind: 'github-release',
                    source: 'acme/sdk-upstream',
                    allowPrerelease: true,
                    versionFrom: {
                      domain: 'stage-a',
                      path: 'packages/sdk/package.json',
                      jsonPointer: '/version',
                    },
                  },
                ],
              },
            ],
          },
        }),
        'utf8',
      );

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: init suite repo at 1.1.0']);
      const sha110 = await git(repo, ['rev-parse', 'HEAD']);

      const secretToken = 'ghp_suite_resolve_tok_123456';

      // 1. Schedule event while Stage A has an open PR -> Stage A eligible, Stage B deferred
      const out1 = join(work, 'gh-out-1.txt');
      const code1 = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_WORKSPACE: repo,
        GITHUB_REPOSITORY: 'acme/mono',
        GITHUB_SHA: sha110,
        GITHUB_API_URL: githubServer.url,
        GITHUB_OUTPUT: out1,
        'INPUT_SUITE-PATH': '.loopwright/suite.yaml',
        'INPUT_RESOLVE-SUITE-ONLY': 'true',
        'INPUT_EVENT-NAME': 'schedule',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'suite-resolve-1',
        'INPUT_GITHUB-TOKEN': secretToken,
      });
      assert.equal(code1, 0);
      assert.equal(lastAuthHeader, `Bearer ${secretToken}`);
      const parsedOut1 = parseGithubOutputs(await readFile(out1, 'utf8'));
      const matrix1 = JSON.parse(parsedOut1['matrix'] ?? '{}') as {
        include: Array<{ domainId: string; taskpackPath: string; baseRevision: string; matrix?: Record<string, unknown> }>;
      };
      assert.equal(matrix1.include.length, 1);
      assert.equal(matrix1.include[0]?.domainId, 'stage-a');
      assert.equal(matrix1.include[0]?.taskpackPath, '.loopwright/stage-a/taskpack.yaml');
      assert.equal(matrix1.include[0]?.baseRevision, sha110);
      assert.deepEqual(matrix1.include[0]?.matrix, { runner: 'ubuntu-latest', tier: 1 });
      const resJson1 = JSON.parse(parsedOut1['result'] ?? '{}') as {
        kind: string;
        suite: { cells: Array<{ domainId: string; disposition: string }> };
      };
      assert.equal(resJson1.kind, 'eligible');
      assert.equal(resJson1.suite.cells.find(c => c.domainId === 'stage-b')?.disposition, 'deferred');

      // 2. Stage A PR merges 1.2.0 on main; dirty working tree has 9.9.9-dirty; probe serves v1.2.0 -> BOTH eligible!
      stageAPrOpen = false;
      await writeFile(join(repo, 'packages', 'sdk', 'package.json'), '{"name":"@acme/sdk","version":"1.2.0"}\n', 'utf8');
      await git(repo, ['add', 'packages/sdk/package.json']);
      await git(repo, ['commit', '-m', 'feat(sdk): release 1.2.0']);
      const sha120 = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, 'packages', 'sdk', 'package.json'), '{"name":"@acme/sdk","version":"9.9.9-dirty"}\n', 'utf8');

      releaseMode = 'ok_1_2_0';
      const out2 = join(work, 'gh-out-2.txt');
      const code2 = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_WORKSPACE: repo,
        GITHUB_REPOSITORY: 'acme/mono',
        GITHUB_SHA: sha120,
        GITHUB_API_URL: githubServer.url,
        GITHUB_OUTPUT: out2,
        'INPUT_SUITE-PATH': '.loopwright/suite.yaml',
        'INPUT_RESOLVE-SUITE-ONLY': 'true',
        'INPUT_EVENT-NAME': 'schedule',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'suite-resolve-2',
        'INPUT_GITHUB-TOKEN': secretToken,
      });
      assert.equal(code2, 0);
      const matrix2 = JSON.parse(parseGithubOutputs(await readFile(out2, 'utf8'))['matrix'] ?? '{}') as {
        include: Array<{ domainId: string; baseRevision: string }>;
      };
      assert.deepEqual(matrix2.include.map(c => c.domainId), ['stage-a', 'stage-b']);
      assert.equal(matrix2.include[1]?.baseRevision, sha120);

      // 3. Probe 404 -> deferred cleanly (exit 0)
      releaseMode = 'not_found_404';
      const out404 = join(work, 'gh-out-404.txt');
      const code404 = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_WORKSPACE: repo,
        GITHUB_REPOSITORY: 'acme/mono',
        GITHUB_SHA: sha120,
        GITHUB_API_URL: githubServer.url,
        GITHUB_OUTPUT: out404,
        'INPUT_SUITE-PATH': '.loopwright/suite.yaml',
        'INPUT_DOMAIN': 'stage-b',
        'INPUT_RESOLVE-SUITE-ONLY': 'true',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'suite-resolve-404',
        'INPUT_GITHUB-TOKEN': secretToken,
      });
      assert.equal(code404, 0);
      const parsed404 = parseGithubOutputs(await readFile(out404, 'utf8'));
      assert.deepEqual(JSON.parse(parsed404['matrix'] ?? '{}'), { include: [] });
      assert.equal((JSON.parse(parsed404['result'] ?? '{}') as { kind: string }).kind, 'deferred');

      // 4. Probe 500, 401, pagination exhaustion, and transport errors -> blocked (exit 1) with secret scrubbing!
      for (const badMode of ['server_500', 'auth_401', 'paginate_exhaust'] as const) {
        releaseMode = badMode;
        const outErr = join(work, `gh-out-${badMode}.txt`);
        const exitErr = await runActionCli({
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_WORKSPACE: repo,
          GITHUB_REPOSITORY: 'acme/mono',
          GITHUB_SHA: sha120,
          GITHUB_API_URL: githubServer.url,
          GITHUB_OUTPUT: outErr,
          'INPUT_SUITE-PATH': '.loopwright/suite.yaml',
          'INPUT_DOMAIN': 'stage-b',
          'INPUT_RESOLVE-SUITE-ONLY': 'true',
          'INPUT_RUN-ROOT': runRoot,
          'INPUT_RUN-ID': `suite-resolve-${badMode}`,
          'INPUT_GITHUB-TOKEN': secretToken,
        });
        assert.equal(exitErr, 1, `expected exit 1 for ${badMode}`);
        const rawErrOut = await readFile(outErr, 'utf8');
        assert.equal(rawErrOut.includes(secretToken), false, 'token must be scrubbed from GITHUB_OUTPUT');
        assert.equal((JSON.parse(parseGithubOutputs(rawErrOut)['result'] ?? '{}') as { kind: string }).kind, 'blocked');
      }

      const transportErrRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        domain: 'stage-b',
        resolveSuiteOnly: true,
        repositoryFullName: 'acme/mono',
        baseRevision: sha120,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'suite-transport-err',
        githubApiBaseUrl: githubServer.url,
        githubToken: secretToken,
        probeFetch: async () => {
          throw new Error(`socket reset with ${secretToken}`);
        },
      });
      assert.equal(transportErrRes.kind, 'blocked');
      if (transportErrRes.kind === 'blocked') {
        assert.equal((transportErrRes.detail ?? '').includes(secretToken), false);
      }

      // 5. Executing a domain cell (`domain: 'stage-a'`) binds stage-a manifest + suite-wide mandatory protected path union
      await git(repo, ['checkout', '--', 'packages/sdk/package.json']);
      const execCellRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        domain: 'stage-a',
        repositoryFullName: 'acme/mono',
        baseRevision: sha120,
        mode: 'candidate',
        force: true,
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'suite-exec-cell',
        dryRun: true,
        providerTokenEnv: 'OPENAI_API_KEY',
        env: { OPENAI_API_KEY: 'sk-test-suite-cell-123456' },
      });
      assert.equal(execCellRes.kind, 'compiled');
      if (execCellRes.kind === 'compiled') {
        assert.equal(execCellRes.manifest.metadata.name, 'stage-a');
        const compiledProtected = execCellRes.taskpack.config.spec.task.spec.scope.protected;
        assert.equal(
          compiledProtected.some(p => p === '.loopwright/suite.yaml' || p === '.loopwright/suite.yaml/**' || p === '.loopwright/**'),
          true,
          'suite.yaml must be protected in compiled TaskContract',
        );
        assert.equal(
          compiledProtected.some(p => p === 'rules/stage-b-guide.md' || p === 'rules/stage-b-guide.md/**'),
          true,
          'peer domain external instruction must be in suite-wide protected path union',
        );
      }

      // 6. Upstream Stage A declaring a pending spec.upstreams update (even with zero open PRs) defers Stage B
      releaseMode = 'ok_1_2_0';
      let upstreamFeedStatus = 200;
      const upstreamFeedUrl = 'https://upstreams.example.invalid/feed.json';
      const upstreamProbeFetch: typeof globalThis.fetch = async (input, init) => {
        const reqUrl = typeof input === 'string'
          ? input
          : (input instanceof URL ? input.href : input.url);
        if (reqUrl === upstreamFeedUrl) {
          if (upstreamFeedStatus !== 200) {
            return new Response('upstream error', { status: upstreamFeedStatus, headers: { 'content-type': 'text/plain' } });
          }
          return new Response(JSON.stringify({ version: '2.0.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return globalThis.fetch(input, init);
      };
      const stageAManifestWithUpstream = makeDomainTaskpackYaml({
        name: 'stage-a',
        writable: ['packages/sdk/**'],
        headBranchPrefix: 'loopwright/stage-a/',
        proposalPath: 'packages/sdk/proposal.json',
        upstreams: [
          {
            id: 'sdk-feed',
            kind: 'http-json',
            source: upstreamFeedUrl,
            versionPath: 'version',
            watchedPaths: ['packages/sdk/package.json'],
          },
        ],
      });
      await writeFile(join(repo, '.loopwright', 'stage-a', 'taskpack.yaml'), stageAManifestWithUpstream, 'utf8');
      await git(repo, ['add', '.loopwright/stage-a/taskpack.yaml']);
      await git(repo, ['commit', '-m', 'chore: declare stage-a upstream']);
      const shaWithUpstream = await git(repo, ['rev-parse', 'HEAD']);

      const deferredByUpstream = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        domain: 'stage-b',
        resolveSuiteOnly: true,
        repositoryFullName: 'acme/mono',
        baseRevision: shaWithUpstream,
        mode: 'candidate',
        eventName: 'schedule',
        runRoot,
        runId: 'suite-upstream-pending',
        githubApiBaseUrl: githubServer.url,
        githubToken: secretToken,
        probeFetch: upstreamProbeFetch,
      });
      assert.equal(deferredByUpstream.kind, 'deferred');
      if (deferredByUpstream.kind === 'deferred') {
        assert.equal(deferredByUpstream.reason, 'stage_not_ready');
      }

      upstreamFeedStatus = 500;
      const blockedByUpstreamErr = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        domain: 'stage-b',
        resolveSuiteOnly: true,
        repositoryFullName: 'acme/mono',
        baseRevision: shaWithUpstream,
        mode: 'candidate',
        eventName: 'schedule',
        runRoot,
        runId: 'suite-upstream-err',
        githubApiBaseUrl: githubServer.url,
        githubToken: secretToken,
        probeFetch: upstreamProbeFetch,
      });
      assert.equal(blockedByUpstreamErr.kind, 'blocked');
    } finally {
      await githubServer.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('fetches PR ownership metadata on issue_comment lacking head/base, routes owning domain, and refuses cross-fork or domain mismatch', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-t9-pr-lookup-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');

    const prFixtures = new Map<number, Record<string, unknown>>();
    let prFetchCalls = 0;
    let observedAuth = '';

    const githubServer = await startHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const match = /^\/repos\/acme\/mono\/pulls\/(\d+)$/.exec(url.pathname);
      if (match !== null && req.method === 'GET') {
        prFetchCalls += 1;
        observedAuth = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : '';
        const num = Number(match[1]);
        const fixture = prFixtures.get(num);
        if (fixture === undefined) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not Found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fixture));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    try {
      await mkdir(join(repo, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repo, '.loopwright', 'runtime'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'packages', 'runtime'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'docs', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, 'packages', 'runtime', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'docs', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'docs-pack',
          controlDir: '.loopwright/docs',
          writable: ['docs/**'],
          headBranchPrefix: 'loopwright/docs/',
          proposalPath: 'docs/proposal.json',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'runtime', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'runtime-pack',
          controlDir: '.loopwright/runtime',
          writable: ['packages/runtime/**'],
          headBranchPrefix: 'loopwright/runtime/',
          proposalPath: 'packages/runtime/proposal.json',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'suite.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'TaskpackSuite',
          metadata: { name: 'comment-routing-suite' },
          spec: {
            domains: [
              { id: 'docs', taskpack: '.loopwright/docs/taskpack.yaml' },
              { id: 'runtime', taskpack: '.loopwright/runtime/taskpack.yaml' },
            ],
          },
        }),
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: init suite']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['checkout', '-b', 'loopwright/runtime/main']);
      await writeFile(join(repo, 'packages', 'runtime', 'proposal.json'), '{"schema_version":1,"version":"1.1.0"}\n', 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'feat(runtime): candidate head']);
      const runtimePrHeadSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', 'main']);

      // PR #21: legitimate same-repo runtime PR
      prFixtures.set(21, {
        number: 21,
        state: 'open',
        base: { ref: 'main', sha: baseSha, repo: { id: 100, full_name: 'acme/mono', fork: false } },
        head: { ref: 'loopwright/runtime/main', sha: runtimePrHeadSha, repo: { id: 100, full_name: 'acme/mono', fork: false } },
      });
      // PR #22: cross-fork PR
      prFixtures.set(22, {
        number: 22,
        state: 'open',
        base: { ref: 'main', sha: baseSha, repo: { id: 100, full_name: 'acme/mono', fork: false } },
        head: { ref: 'loopwright/runtime/main', sha: runtimePrHeadSha, repo: { id: 999, full_name: 'forker/mono', fork: true } },
      });
      // PR #23: deleted fork (`head.repo: null`)
      prFixtures.set(23, {
        number: 23,
        state: 'open',
        base: { ref: 'main', sha: baseSha, repo: { id: 100, full_name: 'acme/mono', fork: false } },
        head: { ref: 'loopwright/runtime/main', sha: runtimePrHeadSha, repo: null },
      });
      // PR #24: unmanaged same-repo feature branch
      prFixtures.set(24, {
        number: 24,
        state: 'open',
        base: { ref: 'main', sha: baseSha, repo: { id: 100, full_name: 'acme/mono', fork: false } },
        head: { ref: 'feature/manual-work', sha: runtimePrHeadSha, repo: { id: 100, full_name: 'acme/mono', fork: false } },
      });

      const makeStandardIssueCommentPayload = (prNumber: number, body: string, login = 'alice', type = 'User') => ({
        action: 'created',
        issue: {
          number: prNumber,
          // Standard GitHub issue_comment webhook payload omits head/base and only provides url!
          pull_request: { url: `${githubServer.url}/repos/acme/mono/pulls/${prNumber}` },
        },
        comment: {
          id: 500 + prNumber,
          body,
          author_association: 'MEMBER',
          user: { login, type },
        },
      });

      // 1. Bot comment is ignored with ZERO /pulls/:number API calls
      const botRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        resolveSuiteOnly: true,
        repositoryFullName: 'acme/mono',
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: makeStandardIssueCommentPayload(21, '/loopwright retry', 'dependabot[bot]', 'Bot'),
        runRoot,
        runId: 'pr-bot-ignored',
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_pr_lookup_tok_999',
      });
      assert.equal(botRes.kind, 'ignored');
      assert.equal(prFetchCalls, 0);

      // 2. Targeted `/loopwright runtime revise` on PR #21 fetches /pulls/21, verifies auth, and compiles runtime-pack with revise intake
      const reviseRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        repositoryFullName: 'acme/mono',
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: makeStandardIssueCommentPayload(21, '/loopwright runtime revise\nTighten runtime bounds.'),
        runRoot,
        runId: 'pr-runtime-revise',
        dryRun: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_pr_lookup_tok_999',
        providerTokenEnv: 'OPENAI_API_KEY',
        env: { OPENAI_API_KEY: 'sk-pr-lookup-key-123' },
      });
      assert.equal(prFetchCalls, 1);
      assert.equal(observedAuth, 'Bearer ghp_pr_lookup_tok_999');
      assert.equal(reviseRes.kind, 'compiled');
      if (reviseRes.kind === 'compiled') {
        assert.equal(reviseRes.manifest.metadata.name, 'runtime-pack');
        assert.equal(reviseRes.intake.kind, 'revise');
        if (reviseRes.intake.kind === 'revise' && reviseRes.intake.disposition === 'ready') {
          assert.equal(reviseRes.intake.command.headSha, runtimePrHeadSha);
        }
        assert.equal(reviseRes.taskpack.config.spec.task.spec.target.sourceRevision, runtimePrHeadSha);
      }

      // 3. Cross-fork PR (#22) and null head.repo PR (#23) are refused fail-closed as blocked (TASKPACK_SCOPE_VIOLATION)
      for (const forkPrNum of [22, 23]) {
        const forkRes = await runGitHubActionEntrypoint({
          repositoryRoot: repo,
          suitePath: '.loopwright/suite.yaml',
          repositoryFullName: 'acme/mono',
          baseRevision: baseSha,
          mode: 'candidate',
          eventName: 'issue_comment',
          eventPayload: makeStandardIssueCommentPayload(forkPrNum, '/loopwright retry'),
          runRoot,
          runId: `pr-fork-${forkPrNum}`,
          dryRun: true,
          githubApiBaseUrl: githubServer.url,
          githubToken: 'ghp_pr_lookup_tok_999',
        });
        assert.equal(forkRes.kind, 'blocked');
        if (forkRes.kind === 'blocked') {
          assert.equal(forkRes.reason, 'TASKPACK_SCOPE_VIOLATION');
          assert.match(forkRes.detail ?? '', /cross-fork/i);
        }
      }

      // 4. Explicit `<domainId>` conflicting with owning `(targetBranch, headBranchPrefix)` -> blocked (TASKPACK_SCOPE_VIOLATION)
      const mismatchRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        repositoryFullName: 'acme/mono',
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: makeStandardIssueCommentPayload(21, '/loopwright docs retry'),
        runRoot,
        runId: 'pr-domain-mismatch',
        dryRun: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_pr_lookup_tok_999',
      });
      assert.equal(mismatchRes.kind, 'blocked');
      if (mismatchRes.kind === 'blocked') {
        assert.equal(mismatchRes.reason, 'TASKPACK_SCOPE_VIOLATION');
        assert.match(mismatchRes.detail ?? '', /docs/);
        assert.match(mismatchRes.detail ?? '', /runtime/);
      }

      // 5. Untargeted comment on unmanaged branch (#24) -> blocked with valid domain IDs listed
      const unmanagedRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        repositoryFullName: 'acme/mono',
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: makeStandardIssueCommentPayload(24, '/loopwright retry'),
        runRoot,
        runId: 'pr-unmanaged',
        dryRun: true,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_pr_lookup_tok_999',
      });
      assert.equal(unmanagedRes.kind, 'blocked');
      if (unmanagedRes.kind === 'blocked') {
        assert.equal(unmanagedRes.reason, 'TASKPACK_SCOPE_VIOLATION');
        assert.match(unmanagedRes.detail ?? '', /docs, runtime/);
      }
    } finally {
      await githubServer.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('supports multi-domain startGitHubAppControlPlane: mutual exclusion, MULTI_TENANT_HOST_POLICY, fan-out deduplication, and manifestDigest lease binding', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-t9-suite-service-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');

    const tokenRequests: InstallationTokenRequest[] = [];
    const broker = new InstallationTokenBroker({
      appId: 99,
      privateKeyPem: PRIVATE_KEY_PEM,
      nowSeconds: () => 1_750_000_000,
      transport: {
        createInstallationToken: async req => {
          tokenRequests.push(req);
          return {
            token: `ghs_suite_${tokenRequests.length.toString().padStart(20, '0')}`,
            expiresAtMs: 1_750_003_600_000,
          };
        },
      },
    });

    const prHeadSha = 'e'.repeat(40);
    const githubApi = await startHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/repos/acme/mono/pulls/31' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          number: 31,
          base: { ref: 'main', sha: '1'.repeat(40), repo: { id: 77, full_name: 'acme/mono', fork: false } },
          head: { ref: 'loopwright/docs/main', sha: prHeadSha, repo: { id: 77, full_name: 'acme/mono', fork: false } },
        }));
        return;
      }
      if (url.pathname === '/repos/acme/mono/pulls/32' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          number: 32,
          base: { ref: 'main', sha: '1'.repeat(40), repo: { id: 77, full_name: 'acme/mono', fork: false } },
          head: { ref: 'loopwright/docs/main', sha: prHeadSha, repo: { id: 888, full_name: 'evil/mono', fork: true } },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let cpHandle: Awaited<ReturnType<typeof startGitHubAppControlPlane>> | undefined;

    try {
      await mkdir(join(repo, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repo, '.loopwright', 'sdk'), { recursive: true });
      await writeFile(
        join(repo, '.loopwright', 'docs', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'docs-sync',
          controlDir: '.loopwright/docs',
          writable: ['docs/**'],
          headBranchPrefix: 'loopwright/docs/',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'sdk', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'sdk-sync',
          controlDir: '.loopwright/sdk',
          writable: ['packages/sdk/**'],
          headBranchPrefix: 'loopwright/sdk/',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'suite.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'TaskpackSuite',
          metadata: { name: 'cp-suite' },
          spec: {
            domains: [
              { id: 'docs', taskpack: '.loopwright/docs/taskpack.yaml', schedules: ['nightly'] },
              { id: 'sdk', taskpack: '.loopwright/sdk/taskpack.yaml', schedules: ['nightly'] },
            ],
          },
        }),
        'utf8',
      );

      const loadedSuite = await loadTaskpackSuite({
        repositoryRoot: repo,
        policyProfile: 'github',
        hostPolicy: MULTI_TENANT_HOST_POLICY,
        enforceHostAuthority: true,
      });

      // 1. Reject specifying both manifest and suite
      await assert.rejects(
        startGitHubAppControlPlane({
          webhookSecret: WEBHOOK_SECRET,
          manifest: loadedSuite.domains[0]!.manifest,
          suite: loadedSuite,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // 2. Reject suite domain violating MULTI_TENANT_HOST_POLICY (allowWorkflowWrites: true)
      const privilegedManifest = parseTaskpackManifest(
        makeDomainTaskpackYaml({
          name: 'priv-sync',
          controlDir: '.loopwright',
          writable: ['docs/**'],
          headBranchPrefix: 'loopwright/priv/',
          allowWorkflowWrites: true,
        }),
        { enforceHostAuthority: false },
      );
      const tamperedSuite = {
        ...loadedSuite,
        domains: [{ ...loadedSuite.domains[0]!, manifest: privilegedManifest }],
      };
      await assert.rejects(
        startGitHubAppControlPlane({
          webhookSecret: WEBHOOK_SECRET,
          suite: tamperedSuite,
        }),
        (err: unknown) => err instanceof GitHubAppError,
      );

      // 3. Start valid multi-domain control plane
      cpHandle = await startGitHubAppControlPlane({
        port: 0,
        webhookSecret: WEBHOOK_SECRET,
        suite: loadedSuite,
        tokenBroker: broker,
        baseRevision: '1'.repeat(40),
        apiBaseUrl: githubApi.url,
      });

      const postWebhook = async (event: string, deliveryId: string, payload: Record<string, unknown>) => {
        const raw = JSON.stringify(payload);
        const res = await fetch(`${cpHandle!.url}/webhooks/github`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': event,
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': signWebhook(raw),
          },
          body: raw,
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };

      // 4. Single schedule delivery fans out across BOTH domains with per-domain manifestDigest
      const schedPayload = {
        schedule: 'nightly',
        installation: { id: 55 },
        repository: { id: 77, full_name: 'acme/mono' },
      };
      const fanout1 = await postWebhook('schedule', 'delivery-fanout-0001', schedPayload);
      assert.equal(fanout1.status, 202);
      assert.equal(fanout1.body['kind'], 'accepted');
      const admittedDomains = fanout1.body['domains'] as Array<{
        domainId: string;
        taskpackId: string;
        manifestDigest: string;
        queueItemId: string;
      }>;
      assert.equal(admittedDomains.length, 2);
      assert.deepEqual(admittedDomains.map(d => d.domainId), ['docs', 'sdk']);
      assert.match(admittedDomains[0]!.manifestDigest, /^[0-9a-f]{64}$/);
      assert.match(admittedDomains[1]!.manifestDigest, /^[0-9a-f]{64}$/);
      // Suite control-plane pins the SHA-256 digest of the suite-augmented manifest, NOT the raw un-augmented file digest
      assert.notEqual(admittedDomains[0]!.manifestDigest, loadedSuite.domains[0]!.manifestSha256);
      assert.notEqual(admittedDomains[1]!.manifestDigest, loadedSuite.domains[1]!.manifestSha256);

      // 5. Replaying the same delivery ID is suppressed idempotently without duplicate queue items
      const replay = await postWebhook('schedule', 'delivery-fanout-0001', schedPayload);
      assert.equal(replay.status, 200);
      assert.equal(replay.body['kind'], 'duplicate');

      const docsTenant: TenantIdentity = {
        installationId: 55,
        repositoryId: 77,
        repositoryFullName: 'acme/mono',
        taskpackId: 'docs-sync',
      };
      const sdkTenant: TenantIdentity = {
        installationId: 55,
        repositoryId: 77,
        repositoryFullName: 'acme/mono',
        taskpackId: 'sdk-sync',
      };
      assert.equal(cpHandle.queue.inspectTenantQueue(docsTenant).counts.pending, 1);
      assert.equal(cpHandle.queue.inspectTenantQueue(sdkTenant).counts.pending, 1);

      // 6. Lease rejects missing pinning, raw un-augmented manifest/digest, and binds suite-augmented manifestDigest + domainId
      const missingPinRes = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-1',
        }),
      });
      assert.equal(missingPinRes.status, 400);
      assert.equal(((await missingPinRes.json()) as { error: { code: string } }).error.code, 'TASKPACK_HOST_BINDING_INVALID');

      const rawUnaugmentedManifest = parseTaskpackManifest(
        await readFile(join(repo, '.loopwright', 'docs', 'taskpack.yaml'), 'utf8'),
        {
          controlRoot: '.loopwright/docs',
          manifestPath: '.loopwright/docs/taskpack.yaml',
          policyProfile: 'github',
          hostPolicy: MULTI_TENANT_HOST_POLICY,
          enforceHostAuthority: true,
        },
      );
      const rawManifestLeaseRes = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-1',
          manifest: rawUnaugmentedManifest,
        }),
      });
      assert.equal(rawManifestLeaseRes.status, 400);
      assert.equal(((await rawManifestLeaseRes.json()) as { error: { code: string } }).error.code, 'TASKPACK_HOST_BINDING_INVALID');

      const rawFileDigestLeaseRes = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-1',
          manifestDigest: loadedSuite.domains[0]!.manifestSha256,
        }),
      });
      assert.equal(rawFileDigestLeaseRes.status, 400);
      assert.equal(((await rawFileDigestLeaseRes.json()) as { error: { code: string } }).error.code, 'TASKPACK_HOST_BINDING_INVALID');

      const goodLeaseDocs = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-1',
          manifestDigest: admittedDomains[0]!.manifestDigest,
        }),
      });
      assert.equal(goodLeaseDocs.status, 200);
      const docsGrant = await goodLeaseDocs.json() as {
        lease: { queueItemId: string; leaseEpoch: number; domainId: string; manifestDigest: string };
        item: { domainId: string; manifestDigest: string };
      };
      assert.equal(docsGrant.lease.domainId, 'docs');
      assert.equal(docsGrant.lease.manifestDigest, admittedDomains[0]!.manifestDigest);
      assert.equal(docsGrant.item.manifestDigest, admittedDomains[0]!.manifestDigest);

      // Suite-augmented manifest body is also accepted on /lease
      const goodLeaseSdkByManifest = await fetch(`${cpHandle.url}/tenants/55/77/sdk-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-2',
          manifest: loadedSuite.domains[1]!.manifest,
        }),
      });
      assert.equal(goodLeaseSdkByManifest.status, 200);
      const sdkGrant = await goodLeaseSdkByManifest.json() as {
        lease: { queueItemId: string; leaseEpoch: number; domainId: string; manifestDigest: string };
      };
      assert.equal(sdkGrant.lease.domainId, 'sdk');
      assert.equal(sdkGrant.lease.manifestDigest, admittedDomains[1]!.manifestDigest);

      // 6b. Failed-settle fan-out redelivery (`retry_failed`) re-enqueues ONLY the failed domain and evicts on succeeded
      const settleDocsOk = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-1',
          queueItemId: docsGrant.lease.queueItemId,
          leaseEpoch: docsGrant.lease.leaseEpoch,
          outcome: 'completed',
        }),
      });
      assert.equal(settleDocsOk.status, 200);

      const settleSdkFail = await fetch(`${cpHandle.url}/tenants/55/77/sdk-sync/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-2',
          queueItemId: sdkGrant.lease.queueItemId,
          leaseEpoch: sdkGrant.lease.leaseEpoch,
          outcome: 'failed',
        }),
      });
      assert.equal(settleSdkFail.status, 200);
      assert.equal(cpHandle.deliveryStore.getDelivery('delivery-fanout-0001')?.state, 'failed');

      const retryFanout = await postWebhook('schedule', 'delivery-fanout-0001', schedPayload);
      assert.equal(retryFanout.status, 202);
      assert.equal(retryFanout.body['attemptCount'], 2);
      // Completed `docs` domain MUST NOT be duplicated; failed `sdk` domain MUST be re-enqueued!
      assert.equal(cpHandle.queue.inspectTenantQueue(docsTenant).counts.pending, 0);
      assert.equal(cpHandle.queue.inspectTenantQueue(docsTenant).items.length, 1);
      assert.equal(cpHandle.queue.inspectTenantQueue(sdkTenant).counts.pending, 1);
      assert.equal(cpHandle.queue.inspectTenantQueue(sdkTenant).items.length, 2);

      const sdkRetryLease = await fetch(`${cpHandle.url}/tenants/55/77/sdk-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-2',
          manifestDigest: admittedDomains[1]!.manifestDigest,
        }),
      });
      assert.equal(sdkRetryLease.status, 200);
      const sdkRetryGrant = await sdkRetryLease.json() as {
        lease: { queueItemId: string; leaseEpoch: number };
      };
      assert.notEqual(sdkRetryGrant.lease.queueItemId, sdkGrant.lease.queueItemId);
      const settleSdkRetryOk = await fetch(`${cpHandle.url}/tenants/55/77/sdk-sync/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'worker-2',
          queueItemId: sdkRetryGrant.lease.queueItemId,
          leaseEpoch: sdkRetryGrant.lease.leaseEpoch,
          outcome: 'completed',
        }),
      });
      assert.equal(settleSdkRetryOk.status, 200);
      assert.equal(cpHandle.deliveryStore.getDelivery('delivery-fanout-0001')?.state, 'succeeded');

      const postSuccessReplay = await postWebhook('schedule', 'delivery-fanout-0001', schedPayload);
      assert.equal(postSuccessReplay.status, 200);
      assert.equal(postSuccessReplay.body['kind'], 'duplicate');
      assert.equal(postSuccessReplay.body['state'], 'succeeded');

      // 7. Signed issue_comment webhook looks up PR #31 via read_only installation token, routes to docs, and refuses cross-fork PR #32 + domain mismatch
      const commentOk = await postWebhook('issue_comment', 'delivery-comment-0031', {
        action: 'created',
        installation: { id: 55 },
        repository: { id: 77, full_name: 'acme/mono' },
        issue: { number: 31, pull_request: { url: `${githubApi.url}/repos/acme/mono/pulls/31` } },
        comment: { id: 901, body: '/loopwright revise\nFix typo', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
      });
      assert.equal(commentOk.status, 202);
      const commentDomains = commentOk.body['domains'] as Array<{ domainId: string }>;
      assert.deepEqual(commentDomains.map(d => d.domainId), ['docs']);

      const commentFork = await postWebhook('issue_comment', 'delivery-comment-0032', {
        action: 'created',
        installation: { id: 55 },
        repository: { id: 77, full_name: 'acme/mono' },
        issue: { number: 32, pull_request: { url: `${githubApi.url}/repos/acme/mono/pulls/32` } },
        comment: { id: 902, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
      });
      assert.equal(commentFork.status, 400);
      assert.equal((commentFork.body['error'] as { code: string }).code, 'TASKPACK_SCOPE_VIOLATION');

      const commentMismatch = await postWebhook('issue_comment', 'delivery-comment-0033', {
        action: 'created',
        installation: { id: 55 },
        repository: { id: 77, full_name: 'acme/mono' },
        issue: { number: 31, pull_request: { url: `${githubApi.url}/repos/acme/mono/pulls/31` } },
        comment: { id: 903, body: '/loopwright sdk retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
      });
      assert.equal(commentMismatch.status, 400);
      assert.equal((commentMismatch.body['error'] as { code: string }).code, 'TASKPACK_SCOPE_VIOLATION');
    } finally {
      await cpHandle?.close();
      await githubApi.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('handles PR lookup HTTP/network/JSON/mint failures with 502 redelivery on App, distinct pull_request_metadata_unavailable on Action, URL validation, and default apiBaseUrl in startConfiguredGitHubApp', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-t9-pr-lookup-neg-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');

    let cpHandle: Awaited<ReturnType<typeof startGitHubAppControlPlane>> | undefined;
    let configuredHandle: Awaited<ReturnType<typeof startConfiguredGitHubApp>> | undefined;

    try {
      await mkdir(join(repo, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repo, '.loopwright', 'sdk'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await git(repo, ['init', '-b', 'main']);

      await writeFile(
        join(repo, '.loopwright', 'docs', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'docs-app',
          controlDir: '.loopwright/docs',
          writable: ['docs/**'],
          headBranchPrefix: 'loopwright/docs/',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'sdk', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'sdk-app',
          controlDir: '.loopwright/sdk',
          writable: ['packages/sdk/**'],
          headBranchPrefix: 'loopwright/sdk/',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'suite.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'TaskpackSuite',
          metadata: { name: 'lookup-neg-suite' },
          spec: {
            domains: [
              { id: 'docs', taskpack: '.loopwright/docs/taskpack.yaml' },
              { id: 'sdk', taskpack: '.loopwright/sdk/taskpack.yaml' },
            ],
          },
        }),
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: init']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      const loadedSuite = await loadTaskpackSuite({
        repositoryRoot: repo,
        policyProfile: 'github',
        hostPolicy: MULTI_TENANT_HOST_POLICY,
        enforceHostAuthority: true,
      });

      // 1. Non-HTTPS / non-loopback apiBaseUrl is rejected BEFORE sending any token on both Action and App
      let leakedFetchCalls = 0;
      const badUrlAction = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        suitePath: '.loopwright/suite.yaml',
        resolveSuiteOnly: true,
        repositoryFullName: 'acme/mono',
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 41, pull_request: { url: 'https://api.github.com/repos/acme/mono/pulls/41' } },
          comment: { id: 1, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
        },
        runRoot,
        runId: 'bad-api-url',
        githubApiBaseUrl: 'http://evil.example.com/api',
        githubToken: 'ghp_must_never_be_sent_12345',
        probeFetch: async () => {
          leakedFetchCalls += 1;
          return new Response('{}', { status: 200 });
        },
      });
      assert.equal(badUrlAction.kind, 'blocked');
      if (badUrlAction.kind === 'blocked') {
        assert.equal(badUrlAction.reason, 'ACTION_INPUT_INVALID');
      }
      assert.equal(leakedFetchCalls, 0);

      await assert.rejects(
        startGitHubAppControlPlane({
          webhookSecret: WEBHOOK_SECRET,
          suite: loadedSuite,
          apiBaseUrl: 'http://evil.example.com/api',
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      // 2. Action (`action.ts`): non-2xx, network/abort error, invalid JSON, and missing metadata emit `pull_request_metadata_unavailable` (NOT cross-fork!)
      const actionModes: Array<'http_503' | 'abort' | 'invalid_json' | 'missing_meta'> = [
        'http_503',
        'abort',
        'invalid_json',
        'missing_meta',
      ];
      for (const mode of actionModes) {
        const res = await runGitHubActionEntrypoint({
          repositoryRoot: repo,
          suitePath: '.loopwright/suite.yaml',
          resolveSuiteOnly: true,
          repositoryFullName: 'acme/mono',
          baseRevision: baseSha,
          mode: 'candidate',
          eventName: 'issue_comment',
          eventPayload: {
            action: 'created',
            issue: mode === 'missing_meta'
              ? { pull_request: {} }
              : { number: 41, pull_request: { url: 'https://api.github.com/repos/acme/mono/pulls/41' } },
            comment: { id: 10, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
          },
          runRoot,
          runId: `action-pr-${mode}`,
          githubToken: 'ghp_secret_lookup_token_777',
          probeFetch: async () => {
            if (mode === 'http_503') return new Response('upstream unavailable', { status: 503 });
            if (mode === 'abort') throw new DOMException('The operation was aborted', 'AbortError');
            return new Response('{corrupt-json', { status: 200, headers: { 'content-type': 'application/json' } });
          },
        });
        assert.equal(res.kind, 'blocked', `expected blocked for mode=${mode}`);
        if (res.kind === 'blocked') {
          assert.equal(res.reason, 'pull_request_metadata_unavailable');
          assert.doesNotMatch(res.detail ?? '', /cross-fork/i);
          assert.doesNotMatch(res.detail ?? '', /ghp_secret_lookup_token_777/);
        }
      }

      // 3. App (`service.ts`): non-2xx, network/abort, invalid JSON, and token-mint failure ALL return 502 + mark delivery `failed`, allowing subsequent redelivery to succeed!
      let simBehavior: 'http_503' | 'abort' | 'invalid_json' | 'mint_throw' | 'ok' = 'http_503';
      const flakyBroker = new InstallationTokenBroker({
        appId: 99,
        privateKeyPem: PRIVATE_KEY_PEM,
        nowSeconds: () => 1_750_000_000,
        transport: {
          createInstallationToken: async () => {
            if (simBehavior === 'mint_throw') {
              throw new Error('token mint transport timeout with secret ghs_leak_attempt_999');
            }
            return { token: 'ghs_flaky_broker_token_000001', expiresAtMs: 1_750_003_600_000 };
          },
        },
      });
      flakyBroker.scrubber.register('ghs_leak_attempt_999');

      cpHandle = await startGitHubAppControlPlane({
        port: 0,
        webhookSecret: WEBHOOK_SECRET,
        suite: loadedSuite,
        tokenBroker: flakyBroker,
        baseRevision: baseSha,
        fetchImpl: async url => {
          const target = String(url);
          assert.equal(target, 'https://api.github.com/repos/acme/mono/pulls/41');
          if (simBehavior === 'http_503') return new Response('gateway timeout', { status: 503 });
          if (simBehavior === 'abort') throw new TypeError('fetch failed: socket hang up');
          if (simBehavior === 'invalid_json') return new Response('<<<not-json>>>', { status: 200 });
          return new Response(JSON.stringify({
            number: 41,
            base: { ref: 'main', sha: baseSha, repo: { id: 77, full_name: 'acme/mono', fork: false } },
            head: { ref: 'loopwright/docs/main', sha: baseSha, repo: { id: 77, full_name: 'acme/mono', fork: false } },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });

      const prCommentWebhookPayload = {
        action: 'created',
        installation: { id: 55 },
        repository: { id: 77, full_name: 'acme/mono' },
        issue: { number: 41, pull_request: { url: 'https://api.github.com/repos/acme/mono/pulls/41' } },
        comment: { id: 410, body: '/loopwright retry', author_association: 'MEMBER', user: { login: 'dev', type: 'User' } },
      };

      const sendToCp = async (deliveryId: string) => {
        const raw = JSON.stringify(prCommentWebhookPayload);
        const r = await fetch(`${cpHandle!.url}/webhooks/github`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'issue_comment',
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': signWebhook(raw),
          },
          body: raw,
        });
        return { status: r.status, body: await r.json() as Record<string, unknown> };
      };

      for (const failureMode of ['http_503', 'abort', 'invalid_json', 'mint_throw'] as const) {
        const deliveryId = `delivery-flaky-${failureMode.replace(/_/g, '-')}`;
        // Invalidate cached installation token before testing mint_throw so broker invokes transport
        if (failureMode === 'mint_throw') {
          flakyBroker.revokeInstallationTokens(55);
        }
        simBehavior = failureMode;
        const failedAttempt = await sendToCp(deliveryId);
        assert.equal(failedAttempt.status, 502, `expected 502 for ${failureMode}`);
        assert.equal(cpHandle.deliveryStore.getDelivery(deliveryId)?.state, 'failed');
        const errText = JSON.stringify(failedAttempt.body);
        assert.doesNotMatch(errText, /ghs_leak_attempt_999|ghs_flaky_broker_token_000001/);

        // Subsequent GitHub redelivery with the SAME deliveryId succeeds once upstream recovers!
        simBehavior = 'ok';
        const redelivered = await sendToCp(deliveryId);
        assert.equal(redelivered.status, 202, `expected 202 redelivery for ${failureMode}`);
        assert.equal(redelivered.body['kind'], 'accepted');
        assert.equal(redelivered.body['attemptCount'], 2);
      }

      // 4. `startConfiguredGitHubApp` configured with `suitePath` and NO `spec.apiBaseUrl` defaults to `https://api.github.com` and resolves `/loopwright retry`!
      const appConfigPath = join(work, 'github-app.yaml');
      await writeFile(
        appConfigPath,
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'GitHubAppConfig',
          spec: {
            appId: 99,
            webhookSecretEnv: 'TEST_WEBHOOK_SECRET',
            privateKeyEnv: 'TEST_APP_PRIVATE_KEY',
            suitePath: '.loopwright/suite.yaml',
            listen: {
              enabled: true,
              host: '127.0.0.1',
              port: 0,
            },
          },
        }),
        'utf8',
      );

      const seenUrls: string[] = [];
      configuredHandle = await startConfiguredGitHubApp(appConfigPath, {
        repoRoot: repo,
        env: {
          TEST_WEBHOOK_SECRET: WEBHOOK_SECRET,
          TEST_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        },
        fetchImpl: async (inputUrl, init) => {
          const urlStr = String(inputUrl);
          seenUrls.push(urlStr);
          if (urlStr === 'https://api.github.com/app/installations/55/access_tokens' && init?.method === 'POST') {
            return new Response(JSON.stringify({
              token: 'ghs_configured_default_api_token_12345',
              expires_at: new Date(Date.now() + 1_800_000).toISOString(),
            }), { status: 201, headers: { 'content-type': 'application/json' } });
          }
          if (urlStr === 'https://api.github.com/repos/acme/mono/pulls/41') {
            return new Response(JSON.stringify({
              number: 41,
              base: { ref: 'main', sha: baseSha, repo: { id: 77, full_name: 'acme/mono', fork: false } },
              head: { ref: 'loopwright/docs/main', sha: baseSha, repo: { id: 77, full_name: 'acme/mono', fork: false } },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response('not found', { status: 404 });
        },
      });

      const rawComment = JSON.stringify(prCommentWebhookPayload);
      const configuredRes = await fetch(`${configuredHandle.url}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issue_comment',
          'x-github-delivery': 'delivery-configured-default-api-01',
          'x-hub-signature-256': signWebhook(rawComment),
        },
        body: rawComment,
      });
      assert.equal(configuredRes.status, 202);
      const configuredBody = await configuredRes.json() as {
        kind: string;
        domains: Array<{ domainId: string; taskpackId: string }>;
      };
      assert.equal(configuredBody.kind, 'accepted');
      assert.deepEqual(configuredBody.domains.map(d => d.domainId), ['docs']);
      assert.ok(seenUrls.includes('https://api.github.com/app/installations/55/access_tokens'));
      assert.ok(seenUrls.includes('https://api.github.com/repos/acme/mono/pulls/41'));
    } finally {
      await configuredHandle?.close();
      await cpHandle?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('halts fail-fast baseline conflicts strictly BEFORE model candidate health probes with zero .git/objects mutations', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-t9-failfast-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');

    try {
      await mkdir(join(repo, '.loopwright'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, 'src', 'app.ts'), 'export const version = "1.0.0";\n', 'utf8');
      await writeFile(join(repo, 'src', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'fail-fast-pack' },
          spec: {
            goal: { candidate: 'Sync app.ts.', noChange: 'No change.' },
            scope: { writable: ['src/**'], protected: [] },
            proposal: { path: 'src/proposal.json', requiredFields: ['schema_version', 'version'], schemaVersion: 1 },
            verification: {
              localChecks: [{ id: 'prop-json', implementation: 'json-artifact.v1' }],
              externalGates: [],
            },
            publication: { mode: 'disabled' },
            memory: { directory: '.loopwright/memory/fail-fast-pack', apply: 'disabled' },
            triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: ['retry'] },
            // Configure TWO candidates so selectHealthyModelCandidate WOULD probe via probeFetch if reached!
            models: [
              { provider: 'openai', id: 'gpt-4.1-mini', api: 'openai-completions', apiKeyEnv: 'OPENAI_KEY_1', baseUrl: 'http://127.0.0.1:65531/v1' },
              { provider: 'openai', id: 'gpt-4.1', api: 'openai-completions', apiKeyEnv: 'OPENAI_KEY_2', baseUrl: 'http://127.0.0.1:65532/v1' },
            ],
          },
        }),
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: merge-base']);

      await git(repo, ['checkout', '-b', 'pr-branch']);
      await writeFile(join(repo, 'src', 'app.ts'), 'export const version = "2.0.0-source";\n', 'utf8');
      await git(repo, ['add', 'src/app.ts']);
      await git(repo, ['commit', '-m', 'feat: source branch edit']);
      const sourceSha = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['checkout', 'main']);
      await writeFile(join(repo, 'src', 'app.ts'), 'export const version = "1.5.0-base";\n', 'utf8');
      await git(repo, ['add', 'src/app.ts']);
      await git(repo, ['commit', '-m', 'feat: conflicting base branch edit']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      const objectsBefore = await snapshotGitObjects(repo);
      let probeCalls = 0;
      let adapterCalls = 0;

      const blockedRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'acme/failfast',
        baseRevision: baseSha,
        sourceRevision: sourceSha,
        mode: 'candidate',
        force: true,
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-failfast-preprobe',
        allowManifestCustomBaseUrl: true,
        probeFetch: async () => {
          probeCalls += 1;
          throw new Error('probeFetch must NEVER be called when pre-probe fail-fast blocks');
        },
        openHostSessionAdapter: (async () => {
          adapterCalls += 1;
          throw new Error('adapter must NEVER be called');
        }) as never,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          'INPUT_BASELINE-ALIGNMENT': 'fail-fast',
          OPENAI_KEY_1: 'sk-candidate-1',
          OPENAI_KEY_2: 'sk-candidate-2',
        },
      });

      const objectsAfter = await snapshotGitObjects(repo);
      assert.equal(blockedRes.kind, 'blocked');
      if (blockedRes.kind === 'blocked') {
        assert.equal(blockedRes.reason, BASELINE_CONFLICT_REASON);
        assert.match(blockedRes.detail ?? '', /src\/app\.ts/);
      }
      assert.equal(probeCalls, 0, 'selectHealthyModelCandidate probeFetch must be called 0 times');
      assert.equal(adapterCalls, 0, 'model adapter must be called 0 times');
      assert.deepEqual(objectsAfter, objectsBefore, 'host .git/objects must receive ZERO writes');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('enforces extract-context conflict resolution, publishes byte-identical 3-way reconciled PR trees, emits Run Health in Step Summary, and refuses unmerged off conflicts in publisher.ts', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-t9-3way-pub-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');

    let agentScenario: 'leave_unresolved' | 'resolve_and_edit_shared' = 'leave_unresolved';
    let turn = 0;
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      openAiServer = await startHttpServer(async (_req, res) => {
        const cur = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (cur === 0) {
          res.end(sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'src/proposal.json',
            content: '{"schema_version":1,"version":"2.0.0"}\n',
          }));
          return;
        }
        if (agentScenario === 'resolve_and_edit_shared' && cur === 1) {
          res.end(sseToolCall('gpt-4.1-mini', 'c2', 'write', {
            path: 'src/conflict.ts',
            content: 'export const merged = "base+source+candidate";\n',
          }));
          return;
        }
        if (agentScenario === 'resolve_and_edit_shared' && cur === 2) {
          // Candidate starts from sourceRevision (`header-orig ... middle-from-source ... footer-orig`)
          // and edits ONLY the bottom footer line; publisher 3-way reconciliation MUST preserve `header-from-base`!
          res.end(sseToolCall('gpt-4.1-mini', 'c3', 'write', {
            path: 'src/shared.ts',
            content: [
              'export const header = "orig";',
              'export const spacer1 = 1;',
              'export const spacer2 = 2;',
              'export const middle = "from-source";',
              'export const spacer3 = 3;',
              'export const spacer4 = 4;',
              'export const footer = "from-candidate";',
            ].join('\n') + '\n',
          }));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [],
          reason: null,
        })));
      });

      let publishedPrCount = 0;
      let lastPublishedHeadRef = '';
      let currentMainSha = '';

      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/reconcile' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 808 }));
          return;
        }
        if (url.pathname === '/repos/acme/reconcile/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (url.pathname === '/repos/acme/reconcile/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          publishedPrCount += 1;
          lastPublishedHeadRef = String(payload['head'] ?? '');
          const lsOut = await git(repo, ['ls-remote', bareRemote, `refs/heads/${lastPublishedHeadRef}`]);
          const remoteSha = lsOut.split(/\s+/)[0] ?? '';
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 90,
            html_url: 'https://github.invalid/acme/reconcile/pull/90',
            state: 'open',
            head: { ref: lastPublishedHeadRef, sha: remoteSha, repo: { full_name: 'acme/reconcile', fork: false } },
            base: { ref: 'main', sha: currentMainSha, repo: { full_name: 'acme/reconcile', fork: false } },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await mkdir(join(repo, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });

      await writeFile(
        join(repo, '.loopwright', 'checks', 'verify-tree.sh'),
        [
          '#!/bin/sh',
          'set -eu',
          'grep -q \'header = "from-base"\' "$LOOPWRIGHT_CANDIDATE_DIR/src/shared.ts"',
          'grep -q \'middle = "from-source"\' "$LOOPWRIGHT_CANDIDATE_DIR/src/shared.ts"',
          'grep -q \'footer = "from-candidate"\' "$LOOPWRIGHT_CANDIDATE_DIR/src/shared.ts"',
          'grep -q \'merged = "base+source+candidate"\' "$LOOPWRIGHT_CANDIDATE_DIR/src/conflict.ts"',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      await chmod(join(repo, '.loopwright', 'checks', 'verify-tree.sh'), 0o755);

      await writeFile(
        join(repo, 'src', 'shared.ts'),
        [
          'export const header = "orig";',
          'export const spacer1 = 1;',
          'export const spacer2 = 2;',
          'export const middle = "orig";',
          'export const spacer3 = 3;',
          'export const spacer4 = 4;',
          'export const footer = "orig";',
        ].join('\n') + '\n',
        'utf8',
      );
      await writeFile(join(repo, 'src', 'conflict.ts'), 'export const merged = "orig";\n', 'utf8');
      await writeFile(join(repo, 'src', 'proposal.json'), '{"schema_version":1,"version":"1.0.0"}\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'reconcile-pack' },
          spec: {
            goal: { candidate: 'Reconcile src files.', noChange: 'Confirm no change.' },
            scope: { writable: ['src/**'], protected: [] },
            proposal: { path: 'src/proposal.json', requiredFields: ['schema_version', 'version'], schemaVersion: 1 },
            baselineAlignment: { policy: 'extract-context' },
            verification: {
              localChecks: [
                { id: 'prop-json', implementation: 'json-artifact.v1' },
                { id: 'verify-tree', implementation: 'command.v1', parameters: { script: '.loopwright/checks/verify-tree.sh', timeoutSeconds: 20 } },
              ],
              externalGates: [],
            },
            publication: {
              mode: 'pull_request',
              targetBranch: 'main',
              headBranchPrefix: 'loopwright/reconcile/',
              titleTemplate: 'chore: 3-way reconcile',
            },
            memory: { directory: '.loopwright/memory/reconcile-pack', apply: 'disabled' },
            triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: ['retry'] },
            models: [
              {
                provider: 'openai',
                id: 'gpt-4.1-mini',
                api: 'openai-completions',
                apiKeyEnv: 'LLM_TOKEN',
                baseUrl: `${openAiServer.url}/v1`,
                cost: { input: 1, output: 2 },
              },
            ],
            limits: { maxAttempts: 1, maxImplementationRepairs: 0, maxFormatRepairs: 0 },
            output: { formats: ['json', 'github-step-summary'] },
          },
        }),
        'utf8',
      );

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: merge-base']);

      // Source branch edits middle of shared.ts and conflict.ts
      await git(repo, ['checkout', '-b', 'source-branch']);
      await writeFile(
        join(repo, 'src', 'shared.ts'),
        [
          'export const header = "orig";',
          'export const spacer1 = 1;',
          'export const spacer2 = 2;',
          'export const middle = "from-source";',
          'export const spacer3 = 3;',
          'export const spacer4 = 4;',
          'export const footer = "orig";',
        ].join('\n') + '\n',
        'utf8',
      );
      await writeFile(join(repo, 'src', 'conflict.ts'), 'export const merged = "from-source";\n', 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'feat: source edits']);
      const sourceSha = await git(repo, ['rev-parse', 'HEAD']);

      // Base branch (`main`) edits top header of shared.ts (disjoint!) and conflict.ts (conflicting!)
      await git(repo, ['checkout', 'main']);
      await writeFile(
        join(repo, 'src', 'shared.ts'),
        [
          'export const header = "from-base";',
          'export const spacer1 = 1;',
          'export const spacer2 = 2;',
          'export const middle = "orig";',
          'export const spacer3 = 3;',
          'export const spacer4 = 4;',
          'export const footer = "orig";',
        ].join('\n') + '\n',
        'utf8',
      );
      await writeFile(join(repo, 'src', 'conflict.ts'), 'export const merged = "from-base";\n', 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'feat: base edits']);
      currentMainSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // 1. Candidate leaves extracted conflict unresolved -> verification fails closed, zero PRs published
      agentScenario = 'leave_unresolved';
      turn = 0;
      const unresolvedRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'acme/reconcile',
        repositoryId: 808,
        baseRevision: currentMainSha,
        sourceRevision: sourceSha,
        mode: 'candidate',
        force: true,
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-extract-unresolved',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_reconcile_tok_123',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          RUNNER_ENVIRONMENT: 'github-hosted',
          LLM_TOKEN: 'sk-reconcile-llm-123',
        },
      });
      assert.equal(unresolvedRes.kind, 'compiled');
      if (unresolvedRes.kind === 'compiled') {
        assert.equal(unresolvedRes.delegateOutcome?.ok, false);
        const stagedConflictsPath = join(
          unresolvedRes.taskpack.trustedDirectory,
          'registry',
          BASELINE_CONFLICT_RESOURCE_PATH,
        );
        const conflictStat = await stat(stagedConflictsPath);
        assert.equal(conflictStat.mode & 0o777, 0o400, 'conflicts.json must be staged read-only (0o400)');
      }
      assert.equal(publishedPrCount, 0);

      // 2. Candidate resolves src/conflict.ts AND edits footer of src/shared.ts -> published PR tree preserves all 3 disjoint edits + Step Summary includes Run Health!
      agentScenario = 'resolve_and_edit_shared';
      turn = 0;
      const stepSummaryPath = join(work, 'step-summary-resolved.md');
      const githubOutPath = join(work, 'gh-out-resolved.txt');
      const resolvedExit = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_WORKSPACE: repo,
        LOOPWRIGHT_REPOSITORY: 'acme/reconcile',
        GITHUB_SHA: currentMainSha,
        GITHUB_API_URL: githubServer.url,
        GITHUB_STEP_SUMMARY: stepSummaryPath,
        GITHUB_OUTPUT: githubOutPath,
        'INPUT_FORCE': 'true',
        'INPUT_SOURCE-REVISION': sourceSha,
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'run-extract-resolved',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_GITHUB-TOKEN': 'ghp_reconcile_tok_123',
        'INPUT_REMOTE-URL': bareRemote,
        LLM_TOKEN: 'sk-reconcile-llm-123',
      }, { openHostSessionAdapter: fastAdapter });

      assert.equal(resolvedExit, 0);
      assert.equal(publishedPrCount, 1);

      const stepSummaryMd = await readFile(stepSummaryPath, 'utf8');
      assert.match(stepSummaryMd, /Run Health/, 'GitHub Step Summary must render deterministic RunEval Run Health');

      const publishedClone = join(work, 'published-clone');
      await git(work, ['clone', '--branch', lastPublishedHeadRef, bareRemote, publishedClone]);
      const publishedShared = await readFile(join(publishedClone, 'src', 'shared.ts'), 'utf8');
      assert.equal(
        publishedShared,
        [
          'export const header = "from-base";',
          'export const spacer1 = 1;',
          'export const spacer2 = 2;',
          'export const middle = "from-source";',
          'export const spacer3 = 3;',
          'export const spacer4 = 4;',
          'export const footer = "from-candidate";',
        ].join('\n') + '\n',
        'published PR tree must preserve baseRevision + sourceRevision + candidate disjoint lines identically to verified tree',
      );
      const publishedConflict = await readFile(join(publishedClone, 'src', 'conflict.ts'), 'utf8');
      assert.equal(publishedConflict, 'export const merged = "base+source+candidate";\n');

      // 3. Direct publisher.ts fail-closed check when policy: 'off' (no baseline-conflict-context resource) encounters unmerged conflict
      let capturedPubReceipt: { outcome?: string; reason?: string | null } | null = null;
      const pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/reconcile',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/off/',
        remoteUrl: bareRemote,
        apiBaseUrl: githubServer.url,
        gitWriteToken: 'ghp_reconcile_tok_123',
      });
      const pubObserver = await startHttpServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const upstream = await fetch(pubServer.url, {
          method: req.method ?? 'POST',
          headers: {
            'content-type': String(req.headers['content-type'] ?? 'application/json'),
            authorization: String(req.headers['authorization'] ?? ''),
            'x-loopwright-signature': String(req.headers['x-loopwright-signature'] ?? ''),
          },
          body: Buffer.concat(chunks),
        });
        const respBuf = Buffer.from(await upstream.arrayBuffer());
        capturedPubReceipt = JSON.parse(respBuf.toString('utf8')) as { outcome?: string; reason?: string | null };
        const sig = upstream.headers.get('x-loopwright-signature');
        res.writeHead(upstream.status, {
          'content-type': 'application/json',
          'content-length': String(respBuf.byteLength),
          ...(sig !== null ? { 'x-loopwright-signature': sig } : {}),
        });
        res.end(respBuf);
      });
      try {
        const offManifest = parseTaskpackManifest(
          makeDomainTaskpackYaml({
            name: 'off-pub-pack',
            controlDir: '.loopwright',
            writable: ['src/**'],
            headBranchPrefix: 'loopwright/off/',
            proposalPath: 'src/proposal.json',
            baselineAlignmentPolicy: 'off',
          }),
        );
        const offCompiled = await compileDeclarativeTaskpack(offManifest, {
          mode: 'candidate',
          executionMode: 'delegated',
          repository: 'acme/reconcile',
          repositoryRoot: repo,
          baseRevision: currentMainSha,
          sourceRevision: sourceSha,
          budgets: DEFAULT_HOST_BUDGETS,
          publicationEndpoint: {
            ...pubServer.endpointPlan,
            url: `${pubObserver.url}/publish`,
          },
          credentialEnvMap: {
            publication: 'LOOPWRIGHT_PUBLICATION_SIGNING_SECRET',
            publicationAuth: 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN',
          },
        });
        const offTrustedDir = join(runRoot, 'lw-off-trusted');
        await mkdir(join(offTrustedDir, 'registry'), { recursive: true, mode: 0o700 });
        await mkdir(join(offTrustedDir, 'config'), { recursive: true, mode: 0o700 });
        await chmod(offTrustedDir, 0o700);
        await chmod(join(offTrustedDir, 'registry'), 0o700);
        await chmod(join(offTrustedDir, 'config'), 0o700);
        const offRegPath = join(offTrustedDir, 'registry', 'registry.yaml');
        const offCfgPath = join(offTrustedDir, 'config', 'config.yaml');
        await writeFile(offRegPath, offCompiled.registryBytes, { mode: 0o600 });
        await writeFile(offCfgPath, serializePrettyYaml(offCompiled.config), { mode: 0o600 });

        const pubEnv: Record<string, string | undefined> = {
          LOOPWRIGHT_PUBLICATION_SIGNING_SECRET: pubServer.signingSecret,
          LOOPWRIGHT_PUBLICATION_AUTH_TOKEN: pubServer.authToken,
        };
        const pubEnvFn = (name: string): string | undefined => pubEnv[name];
        const prevSign = process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'];
        const prevAuth = process.env['LOOPWRIGHT_PUBLICATION_AUTH_TOKEN'];
        process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'] = pubServer.signingSecret;
        process.env['LOOPWRIGHT_PUBLICATION_AUTH_TOKEN'] = pubServer.authToken;
        let loadedCfg: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loadedCfg = await loadTrustedConfiguration({
            configPath: offCfgPath,
            registryPath: offRegPath,
            registrySha256: offCompiled.registrySha256,
            untrustedRoots: [repo],
          });
        } finally {
          if (prevSign === undefined) delete process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'];
          else process.env['LOOPWRIGHT_PUBLICATION_SIGNING_SECRET'] = prevSign;
          if (prevAuth === undefined) delete process.env['LOOPWRIGHT_PUBLICATION_AUTH_TOKEN'];
          else process.env['LOOPWRIGHT_PUBLICATION_AUTH_TOKEN'] = prevAuth;
        }
        assert.equal(loadedCfg.ok, true);
        if (!loadedCfg.ok) throw new Error('loadTrustedConfiguration failed');

        const directRunId = 'run-direct-off-conflict';
        const nextOff = await stepNext({
          configuration: loadedCfg.value,
          repository: repo,
          runRoot,
          runId: directRunId,
          mode: 'candidate',
          environment: pubEnvFn,
        });
        assert.equal(nextOff.ok, true);
        if (!nextOff.ok || nextOff.value.kind !== 'step') throw new Error('stepNext failed');

        await writeFile(
          join(nextOff.value.candidateDir, 'src', 'proposal.json'),
          '{"schema_version":1,"version":"3.0.0"}\n',
          { mode: 0o600 },
        );
        const submittedOff = await stepSubmit({
          runRoot,
          runId: directRunId,
          leaseToken: nextOff.value.leaseToken,
          status: 'completed',
          environment: pubEnvFn,
        });
        assert.equal(submittedOff.ok, true);
        if (submittedOff.ok) {
          assert.equal(submittedOff.value.kind, 'result');
          if (submittedOff.value.kind === 'result') {
            assert.equal(submittedOff.value.result.spec.status, 'failed');
            assert.equal(submittedOff.value.result.spec.externalEffects, 'none');
          }
        }
        assert.ok(capturedPubReceipt !== null, 'publisher server must receive publication request');
        const verifiedReceipt = capturedPubReceipt as { outcome?: string; reason?: string | null };
        assert.equal(verifiedReceipt.outcome, 'not_executed');
        assert.match(verifiedReceipt.reason ?? '', /baseline_merge_conflict/);
        assert.equal(await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/off/main']), '');
      } finally {
        await pubObserver.close();
        await pubServer.close();
      }
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('suppresses redelivery after reconcile_required, preserves partial fan-out failures, settles coalesced deliveries, resolves branch SHA via API, and enforces stage readiness on App webhook intake', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-service-r1-guards-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');

    const pinnedMainSha = 'a'.repeat(40);
    let stageAPrOpen = true;
    const broker = new InstallationTokenBroker({
      appId: 101,
      privateKeyPem: PRIVATE_KEY_PEM,
      nowSeconds: () => 1_750_000_000,
      transport: {
        createInstallationToken: async () => ({
          token: 'ghs_r1_guard_token_1234567890',
          expiresAtMs: 1_750_003_600_000,
        }),
      },
    });
    const githubApi = await startHttpServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/repos/acme/mono/git/ref/heads/main' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ref: 'refs/heads/main', object: { sha: pinnedMainSha } }));
        return;
      }
      if (url.pathname === '/repos/acme/mono/pulls' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          stageAPrOpen
            ? JSON.stringify([{
              number: 19,
              title: 'chore(docs): sync',
              html_url: 'https://github.com/acme/mono/pull/19',
              head: { ref: 'loopwright/docs/main', sha: 'b'.repeat(40), repo: { full_name: 'acme/mono', fork: false } },
              base: { ref: 'main', sha: pinnedMainSha },
            }])
            : '[]',
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    let cpHandle: Awaited<ReturnType<typeof startGitHubAppControlPlane>> | undefined;
    try {
      await mkdir(join(repo, '.loopwright', 'docs'), { recursive: true });
      await mkdir(join(repo, '.loopwright', 'sdk'), { recursive: true });
      await writeFile(
        join(repo, '.loopwright', 'docs', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'docs-sync',
          controlDir: '.loopwright/docs',
          writable: ['docs/**'],
          headBranchPrefix: 'loopwright/docs/',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'sdk', 'taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'sdk-sync',
          controlDir: '.loopwright/sdk',
          writable: ['packages/sdk/**'],
          headBranchPrefix: 'loopwright/sdk/',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.loopwright', 'suite.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'TaskpackSuite',
          metadata: { name: 'r1-guard-suite' },
          spec: {
            stages: [
              { id: 'stage-a' },
              { id: 'stage-b', dependsOn: ['stage-a'] },
            ],
            domains: [
              { id: 'docs', taskpack: '.loopwright/docs/taskpack.yaml', stage: 'stage-a', schedules: ['nightly'] },
              { id: 'sdk', taskpack: '.loopwright/sdk/taskpack.yaml', stage: 'stage-b', schedules: ['nightly'] },
            ],
          },
        }),
        'utf8',
      );

      cpHandle = await startGitHubAppControlPlane({
        port: 0,
        webhookSecret: WEBHOOK_SECRET,
        suitePath: '.loopwright/suite.yaml',
        repositoryRoot: repo,
        tokenBroker: broker,
        apiBaseUrl: githubApi.url,
        maxPendingPerGroup: 1,
      });

      const postWebhook = async (deliveryId: string, payload: Record<string, unknown>) => {
        const raw = JSON.stringify(payload);
        const res = await fetch(`${cpHandle!.url}/webhooks/github`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-github-event': 'schedule',
            'x-github-delivery': deliveryId,
            'x-hub-signature-256': signWebhook(raw),
          },
          body: raw,
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };
      const schedPayload = {
        schedule: 'nightly',
        installation: { id: 55 },
        repository: { id: 77, full_name: 'acme/mono' },
      };

      // 1. Stage B is deferred while Stage A has an open PR, AND Stage A pins full 40-hex commit SHA from GitHub API
      const wh1 = await postWebhook('delivery-r1-staged-1', schedPayload);
      assert.equal(wh1.status, 202);
      const domains1 = wh1.body['domains'] as Array<{ domainId: string; manifestDigest: string; queueItemId: string }>;
      assert.deepEqual(domains1.map(d => d.domainId), ['docs']);
      const docsTenant: TenantIdentity = { installationId: 55, repositoryId: 77, repositoryFullName: 'acme/mono', taskpackId: 'docs-sync' };
      const docsQueued = cpHandle.queue.inspectTenantQueue(docsTenant).items[0]!;
      assert.equal(docsQueued.baseRevision, pinnedMainSha);

      // 2. Coalesced second delivery settles when the shared queue item settles as reconcile_required, and redelivery is suppressed
      const whCoalesced = await postWebhook('delivery-r1-staged-2', schedPayload);
      assert.equal(whCoalesced.status, 202);
      assert.equal(whCoalesced.body['coalesced'], true);

      const leaseRes = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryFullName: 'acme/mono', workerId: 'w1', manifestDigest: domains1[0]!.manifestDigest }),
      });
      const leaseBody = await leaseRes.json() as { lease: { queueItemId: string; leaseEpoch: number } };
      const settleRes = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'w1',
          queueItemId: leaseBody.lease.queueItemId,
          leaseEpoch: leaseBody.lease.leaseEpoch,
          outcome: 'reconcile_required',
        }),
      });
      assert.equal(settleRes.status, 200);
      assert.equal(cpHandle.deliveryStore.getDelivery('delivery-r1-staged-1')?.state, 'succeeded');
      assert.equal(cpHandle.deliveryStore.getDelivery('delivery-r1-staged-2')?.state, 'succeeded');

      // Redelivering delivery-r1-staged-1 must NOT enqueue a new queue item!
      const replayAfterReconcile = await postWebhook('delivery-r1-staged-1', schedPayload);
      assert.equal(replayAfterReconcile.status, 200);
      assert.equal(replayAfterReconcile.body['kind'], 'duplicate');
      assert.equal(cpHandle.queue.inspectTenantQueue(docsTenant).items.length, 1);

      // 3. Stage A PR closes -> both docs and sdk are eligible, and partial QUEUE_CAPACITY_EXCEEDED failure on sdk does NOT mark delivery succeeded when docs completes
      stageAPrOpen = false;
      const sdkTenant: TenantIdentity = { installationId: 55, repositoryId: 77, repositoryFullName: 'acme/mono', taskpackId: 'sdk-sync' };
      // Fill sdk queue with a different baseRevision so enqueueing sdk for pinnedMainSha hits QUEUE_CAPACITY_EXCEEDED
      cpHandle.queue.enqueue(sdkTenant, { kind: 'discover', baseRevision: 'c'.repeat(40), deliveryId: 'delivery-filler-sdk' });
      const partialRes = await postWebhook('delivery-r1-partial-1', schedPayload);
      assert.equal(partialRes.status, 429);
      assert.equal(cpHandle.deliveryStore.getDelivery('delivery-r1-partial-1')?.state, 'failed');

      // Lease & complete the already-admitted docs item; delivery must remain failed because sdk was never admitted!
      const leaseDocs2 = await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryFullName: 'acme/mono', workerId: 'w2', manifestDigest: domains1[0]!.manifestDigest }),
      });
      const leaseDocs2Body = await leaseDocs2.json() as { lease: { queueItemId: string; leaseEpoch: number } };
      await fetch(`${cpHandle.url}/tenants/55/77/docs-sync/settle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repositoryFullName: 'acme/mono',
          workerId: 'w2',
          queueItemId: leaseDocs2Body.lease.queueItemId,
          leaseEpoch: leaseDocs2Body.lease.leaseEpoch,
          outcome: 'completed',
        }),
      });
      assert.equal(cpHandle.deliveryStore.getDelivery('delivery-r1-partial-1')?.state, 'failed');
    } finally {
      await cpHandle?.close();
      await githubApi.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('admits multi-domain suites with shared-root carved-out proposal.path in Action dry-run and multi-tenant control plane', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-suite-carved-props-'));
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let cpHandle: Awaited<ReturnType<typeof startGitHubAppControlPlane>> | undefined;
    try {
      await mkdir(join(repo, '.auto-sync', 'proposals'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'instructions'), { recursive: true });
      await mkdir(join(repo, 'pkg', 'alpha'), { recursive: true });
      await mkdir(join(repo, 'pkg', 'beta'), { recursive: true });
      await mkdir(runRoot, { recursive: true });

      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['config', 'user.name', 'Test User']);
      await git(repo, ['config', 'user.email', 'test@example.com']);

      await writeFile(join(repo, '.auto-sync', 'holds.json'), '{}\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'proposals', 'alpha.json'), '{"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'proposals', 'beta.json'), '{"version":"2.0.0"}\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'instructions', 'alpha.md'), '# alpha rules\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'instructions', 'beta.md'), '# beta rules\n', 'utf8');
      await writeFile(join(repo, 'pkg', 'alpha', 'a.txt'), 'a\n', 'utf8');
      await writeFile(join(repo, 'pkg', 'beta', 'b.txt'), 'b\n', 'utf8');

      await writeFile(
        join(repo, '.auto-sync', 'alpha-taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'alpha-sync',
          controlDir: '.auto-sync',
          writable: ['pkg/alpha/**', '.auto-sync/proposals/alpha.json'],
          headBranchPrefix: 'auto-sync-alpha/',
          instructions: ['.auto-sync/instructions/alpha.md'],
          proposalPath: '.auto-sync/proposals/alpha.json',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.auto-sync', 'beta-taskpack.yaml'),
        makeDomainTaskpackYaml({
          name: 'beta-sync',
          controlDir: '.auto-sync',
          writable: ['pkg/beta/**', '.auto-sync/proposals/beta.json'],
          headBranchPrefix: 'auto-sync-beta/',
          instructions: ['.auto-sync/instructions/beta.md'],
          proposalPath: '.auto-sync/proposals/beta.json',
        }),
        'utf8',
      );
      await writeFile(
        join(repo, '.auto-sync', 'suite.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'TaskpackSuite',
          metadata: { name: 'carved-proposals-suite' },
          spec: {
            domains: [
              { id: 'alpha', taskpack: '.auto-sync/alpha-taskpack.yaml', schedules: ['0 2 * * 1'] },
              { id: 'beta', taskpack: '.auto-sync/beta-taskpack.yaml', schedules: ['0 2 * * 2'] },
            ],
          },
        }),
        'utf8',
      );

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: init carved proposals suite']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const loaded = await loadTaskpackSuite({
        repositoryRoot: repo,
        suitePath: '.auto-sync/suite.yaml',
        policyProfile: 'github',
        hostPolicy: MULTI_TENANT_HOST_POLICY,
      });

      // Multi-tenant control plane must accept the loaded suite without TASKPACK_HOST_BINDING_INVALID
      cpHandle = await startGitHubAppControlPlane({
        host: '127.0.0.1',
        port: 0,
        webhookSecret: WEBHOOK_SECRET,
        repositoryRoot: repo,
        suite: loaded,
      });
      assert.equal(cpHandle.url.startsWith('http://127.0.0.1:'), true);

      // Action entrypoint resolve-suite-only and per-domain dry-run both succeed cleanly
      const resolveRes = await runGitHubActionEntrypoint({
        mode: 'auto',
        repositoryRoot: repo,
        suitePath: '.auto-sync/suite.yaml',
        resolveSuiteOnly: true,
        eventName: 'schedule',
        schedule: '0 2 * * 1',
        baseRevision: headSha,
        repositoryFullName: 'acme/mono',
        runRoot,
        runId: 'carved-resolve',
      });
      assert.equal(resolveRes.kind, 'eligible');
      assert.deepEqual(resolveRes.matrix.include.map(c => c.domainId), ['alpha']);

      const dryRunRes = await runGitHubActionEntrypoint({
        mode: 'candidate',
        repositoryRoot: repo,
        suitePath: '.auto-sync/suite.yaml',
        domain: 'alpha',
        dryRun: true,
        force: true,
        eventName: 'workflow_dispatch',
        baseRevision: headSha,
        repositoryFullName: 'acme/mono',
        runRoot,
        runId: 'carved-dry-run',
        providerTokenEnv: 'OPENAI_API_KEY',
        env: { ...process.env, OPENAI_API_KEY: 'sk-test-carved-dry-run' },
      });
      assert.equal(dryRunRes.kind, 'compiled');
    } finally {
      await cpHandle?.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
