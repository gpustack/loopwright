import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compilePlan, loadTrustedConfiguration } from '@loopwright/controller';
import {
  buildNativePullRequestBody,
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  executeTurnkeyActionCycle,
  isRetryablePerRequestTimeout,
  loadDeclarativeTaskpack,
  runGitHubActionEntrypoint,
  SecretScrubber,
  serializePrettyYaml,
  validateTaskpackLimitsDeclaration,
} from '../src/index.js';
import {
  git,
  readJsonBody,
  startHttpServer,
  sseToolCalls,
  sseStop,
} from './mcp-test-fixtures.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';

const fastAdapter = createFastTurnkeyAdapter();

describe('MCP repair sub-budgets, proposal PR formatting, and retryable provider failures', () => {
  it('renders proposal-enriched PR bodies with escaped Markdown tables, secret scrubbing, length bounds, and clean fallback', () => {
    const scrubber = new SecretScrubber();
    const secretVal = 'ghp_proposal_secret_value_abc123';
    scrubber.register(secretVal);
    const digest = 'deadbeefcafebabe'.repeat(4);

    const mapProposal = {
      schema_version: 1,
      summary: `Upgrade CUDA vLLM to 0.19.1 (token=${secretVal}).`,
      subscriptions: {
        'cuda/vllm': {
          status: 'ready',
          engine_version: '0.19.1',
          plugin_version: null,
          reason: 'Upgrade | verified\non main.',
        },
        'cann/vllm': {
          status: 'blocked',
          engine_version: '0.18.0',
          plugin_version: '0.18.0rc1',
          reason: 'Waiting on upstream pairing.',
        },
      },
    };
    const renderedMap = buildNativePullRequestBody({
      runId: 'run-prop-1',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(mapProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(renderedMap.includes('Upgrade CUDA vLLM to 0.19.1'), renderedMap);
    assert.equal(renderedMap.includes(secretVal), false, 'secret must be scrubbed from PR body');
    assert.ok(renderedMap.includes('| Subscription | Status | Engine | Plugin | Reason |'), renderedMap);
    assert.ok(renderedMap.includes('| cuda/vllm | ready | 0.19.1 | - | Upgrade \\| verified on main. |'), renderedMap);
    assert.ok(renderedMap.includes('| cann/vllm | blocked | 0.18.0 | 0.18.0rc1 | Waiting on upstream pairing. |'), renderedMap);
    assert.ok(renderedMap.endsWith('Automated Loopwright update for run `run-prop-1` (`deadbeefcafe`).'), renderedMap);

    const arrayProposal = {
      schema_version: 1,
      summary: 'Array subscriptions summary ' + 'w'.repeat(35_000),
      subscriptions: [
        { subscription: 'rocm/sglang', status: 'unchanged', engine: '0.5.9', plugin: null, reason: 'Current.' },
      ],
    };
    const renderedArray = buildNativePullRequestBody({
      runId: 'run-prop-2',
      candidateDigest: digest,
      proposalPath: './.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(arrayProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(Array.from(renderedArray).length <= 32_000, `expected <= 32000 code points, got ${Array.from(renderedArray).length}`);
    assert.ok(renderedArray.endsWith('Automated Loopwright update for run `run-prop-2` (`deadbeefcafe`).'));

    const expectedFallback = 'Automated Loopwright update for run `run-prop-3` (`deadbeefcafe`).';
    assert.equal(
      buildNativePullRequestBody({
        runId: 'run-prop-3',
        candidateDigest: digest,
        files: [],
        scrubber,
      }),
      expectedFallback,
    );
    assert.equal(
      buildNativePullRequestBody({
        runId: 'run-prop-3',
        candidateDigest: digest,
        proposalPath: '.autosync/proposal.json',
        files: [{ name: '.autosync/proposal.json', bytes: Buffer.from('{not valid json', 'utf8') }],
        stagedPaths: new Set(['.autosync/proposal.json']),
        scrubber,
      }),
      expectedFallback,
    );
    assert.equal(
      buildNativePullRequestBody({
        runId: 'run-prop-3',
        candidateDigest: digest,
        proposalPath: '.autosync/proposal.json',
        files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(mapProposal), 'utf8') }],
        stagedPaths: new Set(['other/file.json']),
        scrubber,
      }),
      expectedFallback,
    );
  });

  it('logs format & implementation repair dispatches, publishes proposal-enriched PR body, and surfaces diagnostic details on exhausted settlement', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-repair-and-pr-body-'));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubApiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      const bareRemote = join(work, 'remote.git');
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await mkdir(join(repo, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repo, '.autosync'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await writeFile(
        join(repo, '.autosync', 'proposal.json'),
        JSON.stringify({ schema_version: 1, summary: 'Initial', subscriptions: {} }, null, 2) + '\n',
        'utf8',
      );
      const checkScript = `#!/bin/sh
grep -q '"ready"' .autosync/proposal.json
`;
      await writeFile(join(repo, '.loopwright', 'checks', 'verify.sh'), checkScript, { mode: 0o755 });

      const createdPrBodies: string[] = [];
      githubApiServer = await startHttpServer(async (req, res) => {
        const url = req.url ?? '';
        if (req.method === 'GET' && url === '/repos/gpustack/runner') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 777, full_name: 'gpustack/runner', default_branch: 'main' }));
          return;
        }
        if (req.method === 'GET' && url.startsWith('/repos/gpustack/runner/pulls')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (req.method === 'POST' && url === '/repos/gpustack/runner/pulls') {
          const body = await readJsonBody(req);
          if (String(body['head'] ?? '').startsWith('loopwright/memory/')) {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ number: 89, html_url: 'https://github.com/gpustack/runner/pull/89' }));
            return;
          }
          createdPrBodies.push(String(body['body'] ?? ''));
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 88, html_url: 'https://github.com/gpustack/runner/pull/88' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });

      let scenario: 'recover_and_publish' | 'exhaust_format' = 'recover_and_publish';
      let callCount = 0;
      const capturedPrompts: string[] = [];
      openAiServer = await startHttpServer(async (req, res) => {
        const url = req.url ?? '';
        if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const body = await readJsonBody(req);
        const messages = Array.isArray(body['messages']) ? body['messages'] : [];
        const lastUser = [...messages].reverse().find(
          m => m !== null && typeof m === 'object' && (m as Record<string, unknown>)['role'] === 'user',
        ) as Record<string, unknown> | undefined;
        const promptStr = typeof lastUser?.['content'] === 'string'
          ? lastUser['content']
          : JSON.stringify(lastUser?.['content'] ?? '');
        capturedPrompts.push(promptStr);

        callCount += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

        if (scenario === 'exhaust_format') {
          res.end(sseStop('glm-5.1', 'Still writing Markdown prose instead of JSON.\n\n- bullet 1'));
          return;
        }

        if (callCount === 1) {
          // Initial authoring: write draft without "ready" status so verify.sh will fail once,
          // then on turn 2 return Markdown prose to trigger format repair!
          res.end(sseToolCalls('glm-5.1', 'c1', [{
            id: 'w1',
            name: 'write',
            args: {
              path: '.autosync/proposal.json',
              content: JSON.stringify({
                schema_version: 1,
                summary: 'Draft without ready status yet.',
                subscriptions: {
                  'cuda/vllm': { status: 'unchanged', engine_version: '0.19.0', plugin_version: null, reason: 'Pending.' },
                },
              }, null, 2) + '\n',
            },
          }]));
          return;
        }
        if (callCount === 2) {
          res.end(sseStop('glm-5.1', 'All edits written.\n\nSubmission summary:\n- Draft written.'));
          return;
        }
        if (callCount === 3) {
          // Format repair (#2 role dispatch): tools disabled, return valid submission.v1 JSON!
          res.end(sseStop('glm-5.1', JSON.stringify({
            version: 1,
            status: 'completed',
            checks: [],
            reason: 'Draft written for verification.',
          })));
          return;
        }
        if (callCount === 4) {
          // Implementation repair (#3 role dispatch): update proposal.json so verify.sh passes!
          res.end(sseToolCalls('glm-5.1', 'c4', [{
            id: 'w2',
            name: 'write',
            args: {
              path: '.autosync/proposal.json',
              content: JSON.stringify({
                schema_version: 1,
                summary: 'Upgrade CUDA vLLM to 0.19.1.',
                subscriptions: {
                  'cuda/vllm': {
                    status: 'ready',
                    engine_version: '0.19.1',
                    plugin_version: null,
                    reason: 'Validated v0.19.1 release.',
                  },
                },
              }, null, 2) + '\n',
            },
          }]));
          return;
        }
        res.end(sseStop('glm-5.1', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [],
          reason: 'Updated cuda/vllm to ready.',
        })));
      });

      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: runner-repair-observability
spec:
  goal:
    candidate: Sync runner upstreams.
    noChange: Confirm upstreams are current.
  scope:
    writable:
      - .autosync
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .autosync/proposal.json
    requiredFields:
      - schema_version
      - summary
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          timeoutSeconds: 10
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: custom-glm
      id: glm-5.1
      thinking: off
      api: openai-completions
      baseUrl: ${openAiServer.url}/v1
      apiKeyEnv: CUSTOM_GLM_TOKEN
      contextWindow: 128000
      maxTokens: 4096
`,
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init repo']);
      await git(repo, ['push', 'origin', 'main']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const r1Root = join(runRoot, 'r1');
      const r2Root = join(runRoot, 'r2');
      await mkdir(r1Root, { recursive: true });
      await mkdir(r2Root, { recursive: true });

      const progressLines: string[] = [];
      const res = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r1Root,
        runId: 'run-repair-e2e',
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        gitRemoteUrl: bareRemote,
        githubApiBaseUrl: githubApiServer.url,
        githubToken: 'ghp_test_write_token_1234',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        progressSink: line => progressLines.push(line),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          CUSTOM_GLM_TOKEN: 'sk_test_repair_token_1234',
        },
      });
      assert.equal(res.kind, 'compiled');
      if (res.kind === 'compiled') {
        assert.equal(res.delegateOutcome?.ok, true, `expected repair + publish to succeed: ${res.delegateOutcome?.detail}\nlogs:\n${progressLines.join('\n')}`);
      }
      assert.ok(
        progressLines.some(l => l.includes('role dispatch #2: format repair (tools disabled)')),
        `missing format repair progress log in:\n${progressLines.join('\n')}`,
      );
      assert.ok(
        progressLines.some(l => l.includes('role dispatch #3: implementation repair')),
        `missing implementation repair progress log in:\n${progressLines.join('\n')}`,
      );
      // Verify formatPrompt sent on call #3 contained the taskpack's allowed check IDs!
      assert.ok(
        capturedPrompts.some(p => p.includes('Allowed checkId values: proposal-check, verify-cmd.')),
        `expected formatPrompt to list allowedCheckIds; prompts:\n${capturedPrompts.join('\n---\n')}`,
      );
      // Verify published PR body is enriched from .autosync/proposal.json!
      assert.equal(createdPrBodies.length, 1);
      assert.match(createdPrBodies[0]!, /Upgrade CUDA vLLM to 0.19.1\./);
      assert.match(createdPrBodies[0]!, /\| Subscription \| Status \| Engine \| Plugin \| Reason \|/);
      assert.match(createdPrBodies[0]!, /\| cuda\/vllm \| ready \| 0\.19\.1 \| - \| Validated v0\.19\.1 release\. \|/);
      assert.match(createdPrBodies[0]!, /Automated Loopwright update for run `run-repair-e2e`/);

      // Now verify non-passing exhausted settlement surfaces concise diagnostic details.
      scenario = 'exhaust_format';
      callCount = 0;
      const exhaustLogs: string[] = [];
      const exhaustedRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r2Root,
        runId: 'run-exhaust-diag',
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        gitRemoteUrl: bareRemote,
        githubApiBaseUrl: githubApiServer.url,
        githubToken: 'ghp_test_write_token_1234',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        progressSink: line => exhaustLogs.push(line),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          CUSTOM_GLM_TOKEN: 'sk_test_repair_token_1234',
          LOOPWRIGHT_MAX_ATTEMPTS: '2',
          LOOPWRIGHT_MAX_FORMAT_REPAIRS: '2',
        },
      });
      assert.equal(exhaustedRes.kind, 'compiled');
      if (exhaustedRes.kind === 'compiled') {
        assert.equal(exhaustedRes.delegateOutcome?.ok, false);
        const detail = exhaustedRes.delegateOutcome?.detail ?? '';
        assert.match(detail, /run run-exhaust-diag settled as exhausted \(/);
        assert.match(detail, /attempts=2\/2/);
        assert.match(detail, /formatRepairs=1\/2/);
        assert.match(detail, /submission=unavailable/);
      }
      assert.ok(
        exhaustLogs.some(l => l.includes('role dispatch #2: format repair (tools disabled)')),
        `expected format repair log in exhausted run:\n${exhaustLogs.join('\n')}`,
      );
      assert.ok(
        exhaustLogs.some(l => l.includes('submission=unavailable')),
        `expected diagnostic detail in exhausted attempt log:\n${exhaustLogs.join('\n')}`,
      );
    } finally {
      await openAiServer?.close();
      await githubApiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('allocates model-call repair sub-budgets (maxImplementationRepairs=32, maxFormatRepairs=6), clamps to maxModelCalls, and completes >3-call implementation repairs across 2 repair dispatches', async () => {
    assert.equal(DEFAULT_HOST_BUDGETS.maxFormatRepairs, 6);
    assert.equal(DEFAULT_HOST_BUDGETS.maxImplementationRepairs, 32);
    assert.equal(DEFAULT_HOST_BUDGETS.maxTransportRetries, 3);

    const validatedHigh = validateTaskpackLimitsDeclaration(
      { maxFormatRepairs: 16, maxImplementationRepairs: 64 },
      '/spec/limits',
    );
    assert.equal(validatedHigh.maxFormatRepairs, 16);
    assert.equal(validatedHigh.maxImplementationRepairs, 64);
    assert.throws(
      () => validateTaskpackLimitsDeclaration({ maxImplementationRepairs: 1025 }, '/spec/limits'),
      /TASKPACK_MANIFEST_INVALID|range|1024/i,
    );

    const work = await mkdtemp(join(tmpdir(), 'lw-repair-subbudgets-'));
    await chmod(work, 0o700);
    const realWork = await realpath(work);
    const repo = join(realWork, 'repo');
    const operator = join(realWork, 'operator');
    const runRoot = join(realWork, 'runs');
    await mkdir(join(repo, '.loopwright', 'checks'), { recursive: true });
    await mkdir(join(repo, '.autosync'), { recursive: true });
    await mkdir(operator, { recursive: true, mode: 0o700 });
    await chmod(operator, 0o700);
    await mkdir(runRoot, { recursive: true, mode: 0o700 });

    const prevToken = process.env['LOOPWRIGHT_PROVIDER_TOKEN'];
    process.env['LOOPWRIGHT_PROVIDER_TOKEN'] = 'sk-subbudget-test-token-123456';
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      await writeFile(join(repo, '.autosync', 'proposal.json'), '{"schema_version":1,"status":"init"}\n', 'utf8');
      await writeFile(
        join(repo, '.loopwright', 'checks', 'verify.sh'),
        '#!/bin/sh\ngrep -q \'"ready"\' .autosync/proposal.json\n',
        { mode: 0o755 },
      );

      let callCount = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const url = req.url ?? '';
        if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
          res.writeHead(404).end();
          return;
        }
        await readJsonBody(req);
        callCount += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Dispatch #1 (author, 2 calls): write status="draft", then submit completed -> verify-cmd fails!
        if (callCount === 1) {
          res.end(sseToolCalls('glm-5.1', 'd1-1', [{
            id: 'c1',
            name: 'write',
            args: { path: '.autosync/proposal.json', content: '{"schema_version":1,"status":"draft"}\n' },
          }]));
          return;
        }
        if (callCount === 2) {
          res.end(sseStop('glm-5.1', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
          return;
        }
        // Dispatch #2 (impl repair #1, 3 calls): read -> write status="staging" -> submit completed -> verify-cmd fails again!
        if (callCount === 3) {
          res.end(sseToolCalls('glm-5.1', 'd2-1', [{
            id: 'c2',
            name: 'read',
            args: { path: '.autosync/proposal.json' },
          }]));
          return;
        }
        if (callCount === 4) {
          res.end(sseToolCalls('glm-5.1', 'd2-2', [{
            id: 'c3',
            name: 'write',
            args: { path: '.autosync/proposal.json', content: '{"schema_version":1,"status":"staging"}\n' },
          }]));
          return;
        }
        if (callCount === 5) {
          res.end(sseStop('glm-5.1', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
          return;
        }
        // Dispatch #3 (impl repair #2, 3 calls -> 6 total impl repair model calls!): read -> write status="ready" -> submit completed -> PASS!
        if (callCount === 6) {
          res.end(sseToolCalls('glm-5.1', 'd3-1', [{
            id: 'c4',
            name: 'read',
            args: { path: '.autosync/proposal.json' },
          }]));
          return;
        }
        if (callCount === 7) {
          res.end(sseToolCalls('glm-5.1', 'd3-2', [{
            id: 'c5',
            name: 'write',
            args: { path: '.autosync/proposal.json', content: '{"schema_version":1,"status":"ready"}\n' },
          }]));
          return;
        }
        res.end(sseStop('glm-5.1', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: subbudget-e2e
spec:
  goal:
    candidate: Update proposal status to ready.
    noChange: Confirm no updates needed.
  scope:
    writable:
      - .autosync
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .autosync/proposal.json
    requiredFields: [schema_version, status]
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          timeoutSeconds: 10
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: custom-glm
      id: glm-5.1
      thinking: off
      api: openai-completions
      baseUrl: ${openAiServer.url}/v1
      apiKeyEnv: CUSTOM_GLM_TOKEN
      contextWindow: 128000
      maxTokens: 4096
`,
        'utf8',
      );
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init subbudget repo']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const defaultCompiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'gpustack/runner',
        repositoryRoot: repo,
        baseRevision: headSha,
        sourceRevision: headSha,
        targetMatrix: null,
        allowManifestCustomBaseUrl: true,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        gateEndpoints: [{
          id: 'taskpack-local-commands',
          url: 'http://127.0.0.1:9/gate',
          signingCredentialRef: 'local-cmd-sig',
        }],
        publicationEndpoint: null,
        credentialEnvMap: {
          provider: 'LOOPWRIGHT_PROVIDER_TOKEN',
          localCommandGate: 'LOOPWRIGHT_PROVIDER_TOKEN',
        },
      });
      assert.equal(defaultCompiled.config.spec.task.spec.budgets.maxFormatRepairs, 6);
      assert.equal(defaultCompiled.config.spec.task.spec.budgets.maxImplementationRepairs, 32);

      // Verify clamping when maxModelCalls < 32 (e.g. maxModelCalls: 5) passes loadTrustedConfiguration + compilePlan!
      const smallModelCallsCompiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'gpustack/runner',
        repositoryRoot: repo,
        baseRevision: headSha,
        sourceRevision: headSha,
        targetMatrix: null,
        allowManifestCustomBaseUrl: true,
        runtimeOptions: {},
        budgets: DEFAULT_HOST_BUDGETS,
        limits: { maxModelCalls: 5 },
        gateEndpoints: [{
          id: 'taskpack-local-commands',
          url: 'http://127.0.0.1:9/gate',
          signingCredentialRef: 'local-cmd-sig',
        }],
        publicationEndpoint: null,
        credentialEnvMap: {
          provider: 'LOOPWRIGHT_PROVIDER_TOKEN',
          localCommandGate: 'LOOPWRIGHT_PROVIDER_TOKEN',
        },
      });
      assert.equal(smallModelCallsCompiled.config.spec.task.spec.budgets.maxModelCalls, 5);
      assert.equal(smallModelCallsCompiled.config.spec.task.spec.budgets.maxFormatRepairs, 5);
      assert.equal(smallModelCallsCompiled.config.spec.task.spec.budgets.maxImplementationRepairs, 5);
      const regDir = join(operator, 'reg');
      const cfgDir = join(operator, 'cfg');
      await mkdir(regDir, { recursive: true, mode: 0o700 });
      await mkdir(cfgDir, { recursive: true, mode: 0o700 });
      await chmod(regDir, 0o700);
      await chmod(cfgDir, 0o700);
      const regPath = join(regDir, 'registry.yaml');
      const cfgPath = join(cfgDir, 'config.yaml');
      await writeFile(regPath, smallModelCallsCompiled.registryBytes, { mode: 0o600 });
      await writeFile(cfgPath, serializePrettyYaml(smallModelCallsCompiled.config), { mode: 0o600 });
      await chmod(regPath, 0o600);
      await chmod(cfgPath, 0o600);
      const loadedSmall = await loadTrustedConfiguration({
        configPath: cfgPath,
        registryPath: regPath,
        registrySha256: smallModelCallsCompiled.registrySha256,
        untrustedRoots: [repo],
      });
      assert.equal(loadedSmall.ok, true, loadedSmall.ok ? '' : `loadTrustedConfiguration failed: ${loadedSmall.error.code}`);
      if (loadedSmall.ok) {
        const planSmall = await compilePlan(loadedSmall.value);
        assert.equal(planSmall.ok, true);
      }

      // Run full turnkey E2E requiring 6 implementation-repair model calls across 2 repair dispatches!
      const logs: string[] = [];
      const e2eRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        repositoryId: 777,
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-multi-impl-repair',
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        progressSink: line => logs.push(line),
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          CUSTOM_GLM_TOKEN: 'sk_test_subbudget_token_1234',
        },
      });
      assert.equal(e2eRes.kind, 'compiled');
      if (e2eRes.kind === 'compiled') {
        assert.equal(e2eRes.delegateOutcome?.ok, true, `expected 6-call impl repair to succeed: ${e2eRes.delegateOutcome?.detail}\n${logs.join('\n')}`);
      }
      assert.equal(callCount, 8);
      assert.ok(logs.some(l => l.includes('role dispatch #2: implementation repair')));
      assert.ok(logs.some(l => l.includes('role dispatch #3: implementation repair')));
    } finally {
      if (prevToken === undefined) delete process.env['LOOPWRIGHT_PROVIDER_TOKEN'];
      else process.env['LOOPWRIGHT_PROVIDER_TOKEN'] = prevToken;
      await openAiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('retries single-candidate taskpack once in a fresh isolated directory on retryableProviderFailure, stops when non-retryable, and rotates immediately for multiple candidates', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-single-retry-'));
    await chmod(work, 0o700);
    const realWork = await realpath(work);
    const repo = join(realWork, 'repo');
    const runRoot = join(realWork, 'runs');
    await mkdir(join(repo, '.loopwright'), { recursive: true });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const prevFirst = process.env['FIRST_KEY'];
    const prevSecond = process.env['SECOND_KEY'];
    try {
      const writeManifest = async (twoModels: boolean): Promise<void> => {
        const modelsYaml = twoModels
          ? `  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      apiKeyEnv: FIRST_KEY
    - provider: zai-coding-cn
      id: glm-5.3
      thinking: high
      apiKeyEnv: SECOND_KEY`
          : `  models:
    - provider: zai-coding-cn
      id: glm-5.3
      thinking: high
      apiKeyEnv: FIRST_KEY`;
        await writeFile(
          join(repo, '.loopwright', 'taskpack.yaml'),
          `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: single-candidate-retry
spec:
  goal:
    candidate: Sync upstreams.
    noChange: Confirm no drift.
  scope:
    writable:
      - .autosync
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .autosync/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
${modelsYaml}
`,
          'utf8',
        );
      };

      await writeManifest(false);
      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, '.autosync-keep'), '', 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);
      process.env['FIRST_KEY'] = 'sk_single_token_123456';
      process.env['SECOND_KEY'] = 'sk_second_token_123456';

      // 1. Single candidate + retryableProviderFailure: true -> retries once in a fresh isolated directory and succeeds on attempt 2!
      const seenDirs1: string[] = [];
      const logs1: string[] = [];
      const r1Root = join(runRoot, 'r1');
      await mkdir(r1Root, { recursive: true, mode: 0o700 });
      const res1 = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        repositoryId: 101,
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r1Root,
        runId: 'single-retry-pass',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        progressSink: line => logs1.push(line),
        env: { FIRST_KEY: 'sk_single_token_123456' },
        delegate: async tp => {
          seenDirs1.push(tp.trustedDirectory);
          if (seenDirs1.length === 1) {
            return { ok: false, detail: 'RECOVERY_REQUIRED: DEADLINE (session)', retryableProviderFailure: true };
          }
          return { ok: true, detail: 'completed on retry' };
        },
      });
      assert.equal(res1.kind, 'compiled');
      assert.equal(seenDirs1.length, 2);
      assert.notEqual(seenDirs1[0], seenDirs1[1], 'retry must compile into a fresh isolated directory');
      if (res1.kind === 'compiled') {
        assert.equal(res1.delegateOutcome?.ok, true);
      }
      assert.ok(logs1.some(l => l.includes('model: retrying primary candidate #1 after transient provider failure')));

      // 2. Single candidate + persistent retryableProviderFailure: true -> capped at 1 retry (2 total calls)!
      let persistentCalls = 0;
      const r2Root = join(runRoot, 'r2');
      await mkdir(r2Root, { recursive: true, mode: 0o700 });
      const res2 = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        repositoryId: 101,
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r2Root,
        runId: 'single-retry-cap',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        env: { FIRST_KEY: 'sk_single_token_123456' },
        delegate: async () => {
          persistentCalls += 1;
          return { ok: false, detail: 'RECOVERY_REQUIRED: DEADLINE (session)', retryableProviderFailure: true };
        },
      });
      assert.equal(res2.kind, 'compiled');
      assert.equal(persistentCalls, 2, 'single-candidate transient retry must run at most once');

      // 3. Single candidate + retryableProviderFailure: false -> stops after 1 call!
      let nonRetryCalls = 0;
      const r3Root = join(runRoot, 'r3');
      await mkdir(r3Root, { recursive: true, mode: 0o700 });
      await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        repositoryId: 101,
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r3Root,
        runId: 'single-non-retry',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        env: { FIRST_KEY: 'sk_single_token_123456' },
        delegate: async () => {
          nonRetryCalls += 1;
          return { ok: false, detail: 'settled as exhausted', retryableProviderFailure: false };
        },
      });
      assert.equal(nonRetryCalls, 1);

      // 4. Multi-candidate (candidates.length === 2) + retryableProviderFailure: true -> rotates immediately to candidate 2!
      await writeManifest(true);
      const seenProviders: string[] = [];
      const r4Root = join(runRoot, 'r4');
      await mkdir(r4Root, { recursive: true, mode: 0o700 });
      const res4 = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        repositoryId: 101,
        baseRevision: headSha,
        sourceRevision: headSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: r4Root,
        runId: 'multi-rotate',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: 'v0.19.1' }],
        probeFetch: async () => new Response(JSON.stringify({ id: 'ok', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
        env: { FIRST_KEY: 'sk_first_token_123456', SECOND_KEY: 'sk_second_token_123456' },
        delegate: async tp => {
          const prov = tp.registry.spec.roleProfiles[0]!.selection.provider;
          seenProviders.push(prov);
          if (prov === 'zai') {
            return { ok: false, detail: 'RECOVERY_REQUIRED: DEADLINE (session)', retryableProviderFailure: true };
          }
          return { ok: true, detail: 'ok' };
        },
      });
      assert.equal(res4.kind, 'compiled');
      assert.deepEqual(seenProviders, ['zai', 'zai-coding-cn']);
    } finally {
      if (prevFirst === undefined) delete process.env['FIRST_KEY'];
      else process.env['FIRST_KEY'] = prevFirst;
      if (prevSecond === undefined) delete process.env['SECOND_KEY'];
      else process.env['SECOND_KEY'] = prevSecond;
      await rm(work, { recursive: true, force: true });
    }
  });

  it('marks per-request DEADLINE (session) retryable when elapsedMs << wallTimeMs without external writes, and keeps full-wallTime DEADLINE non-retryable', async () => {
    assert.equal(
      isRetryablePerRequestTimeout({
        cycleOk: false,
        reasonCode: 'RECOVERY_REQUIRED',
        observedPiErrorDetail: 'DEADLINE (session)',
        externalWriteDispatched: false,
        elapsedMs: 533_000,
        taskWallTimeMs: 3_000_000,
      }),
      true,
    );
    assert.equal(
      isRetryablePerRequestTimeout({
        cycleOk: false,
        reasonCode: 'RECOVERY_REQUIRED',
        observedPiErrorDetail: 'DEADLINE (session)',
        externalWriteDispatched: false,
        elapsedMs: 2_900_000,
        taskWallTimeMs: 3_000_000,
      }),
      false,
      'full-wallTime DEADLINE near taskWallTimeMs must stay non-retryable',
    );
    assert.equal(
      isRetryablePerRequestTimeout({
        cycleOk: false,
        reasonCode: 'RECOVERY_REQUIRED',
        observedPiErrorDetail: 'DEADLINE (session)',
        externalWriteDispatched: true,
        elapsedMs: 533_000,
        taskWallTimeMs: 3_000_000,
      }),
      false,
      'externalWriteDispatched must stay non-retryable',
    );
    assert.equal(
      isRetryablePerRequestTimeout({
        cycleOk: false,
        reasonCode: 'RECOVERY_REQUIRED',
        observedPiErrorDetail: 'DEADLINE (tool)',
        externalWriteDispatched: false,
        elapsedMs: 50_000,
        taskWallTimeMs: 3_000_000,
      }),
      false,
      'tool timeout DEADLINE must stay non-retryable',
    );

    // Integration check through executeTurnkeyActionCycle with simulated DEADLINE (session) adapter:
    const work = await mkdtemp(join(tmpdir(), 'lw-deadline-cycle-'));
    await chmod(work, 0o700);
    const realWork = await realpath(work);
    const repo = join(realWork, 'repo');
    const runRoot = join(realWork, 'runs');
    await mkdir(join(repo, '.loopwright'), { recursive: true });
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    await chmod(runRoot, 0o700);
    const prevToken = process.env['LOOPWRIGHT_PROVIDER_TOKEN'];
    process.env['LOOPWRIGHT_PROVIDER_TOKEN'] = 'sk-deadline-cycle-token-123456';
    try {
      await writeFile(
        join(repo, '.loopwright', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: deadline-cycle
spec:
  goal:
    candidate: Sync upstreams.
    noChange: Confirm no drift.
  scope:
    writable:
      - .autosync
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .autosync/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-check
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .loopwright/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`,
        'utf8',
      );
      await git(repo, ['init', '-b', 'main']);
      await writeFile(join(repo, '.autosync-init'), '1\n', 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: repo,
      });

      const writeWrittenTaskpack = async (wallTimeSeconds: number, suffix: string) => {
        const compiled = await compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          repository: 'gpustack/runner',
          repositoryRoot: repo,
          baseRevision: headSha,
          sourceRevision: headSha,
          targetMatrix: null,
          runtimeOptions: {},
          budgets: DEFAULT_HOST_BUDGETS,
          limits: { wallTimeSeconds },
          publicationEndpoint: null,
          credentialEnvMap: { provider: 'LOOPWRIGHT_PROVIDER_TOKEN' },
        });
        const trustedDirectory = join(runRoot, `trusted-${suffix}`);
        const regDir = join(trustedDirectory, 'registry');
        const cfgDir = join(trustedDirectory, 'config');
        await mkdir(regDir, { recursive: true, mode: 0o700 });
        await mkdir(cfgDir, { recursive: true, mode: 0o700 });
        await chmod(trustedDirectory, 0o700);
        await chmod(regDir, 0o700);
        await chmod(cfgDir, 0o700);
        const registryPath = join(regDir, 'registry.yaml');
        const configPath = join(cfgDir, 'config.yaml');
        const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
        await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
        await writeFile(configPath, configBytes, { mode: 0o600 });
        await chmod(registryPath, 0o600);
        await chmod(configPath, 0o600);
        return { ...compiled, configBytes, trustedDirectory, registryPath, configPath };
      };

      const fakeDeadlineAdapter: NonNullable<Parameters<typeof executeTurnkeyActionCycle>[0]['openHostSessionAdapter']> = async (host, adapterInput, opts) => {
        const opened = await fastAdapter(host, adapterInput, opts);
        if (!opened.ok) return opened;
        const inner = opened.value;
        return {
          ok: true,
          value: {
            ...inner,
            execute: async () => ({
              ok: true,
              value: {
                status: 'recovery_required',
                requestIds: [],
                operationIds: [],
                providerTermination: 'unknown',
                usage: 'incomplete',
                localCleanup: 'complete',
                cleanupError: null,
                error: {
                  code: 'DEADLINE',
                  path: '',
                  phase: 'session',
                  retryable: false,
                  effect: 'possible',
                  requestId: 'req-stalled-1',
                  operationId: 'op-stalled-1',
                  stateErrorCode: null,
                },
              },
            }),
          },
        };
      };

      const ampleWallTaskpack = await writeWrittenTaskpack(3_000, 'ample');
      const ampleRes = await executeTurnkeyActionCycle({
        runId: 'deadline-ample',
        repositoryRoot: repo,
        taskpack: ampleWallTaskpack,
        attemptSeq: 0,
        openHostSessionAdapter: fakeDeadlineAdapter,
      });
      assert.equal(ampleRes.ok, false);
      assert.equal(ampleRes.reasonCode, 'RECOVERY_REQUIRED');
      assert.match(ampleRes.detail, /DEADLINE \(session\)/);
      assert.equal(ampleRes.retryableProviderFailure, true);

      const tightWallTaskpack = await writeWrittenTaskpack(180, 'tight');
      const tightRes = await executeTurnkeyActionCycle({
        runId: 'deadline-tight',
        repositoryRoot: repo,
        taskpack: tightWallTaskpack,
        attemptSeq: 0,
        openHostSessionAdapter: fakeDeadlineAdapter,
      });
      assert.equal(tightRes.ok, false);
      assert.equal(tightRes.retryableProviderFailure, false);
    } finally {
      if (prevToken === undefined) delete process.env['LOOPWRIGHT_PROVIDER_TOKEN'];
      else process.env['LOOPWRIGHT_PROVIDER_TOKEN'] = prevToken;
      await rm(work, { recursive: true, force: true });
    }
  });
});
