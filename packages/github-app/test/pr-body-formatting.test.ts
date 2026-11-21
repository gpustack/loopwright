import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import { inspectRun, loadTrustedConfiguration, signPayload, stepNext, stepSubmit } from '@loopwright/controller';
import { openStagedTaskpackStepGate, resolveGitExecutable, serializePrettyYaml, stageTaskpackForStep } from '@loopwright/taskpack';
import {
  buildNativePullRequestBody,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  makeTreeWritableForCleanup,
  runGitHubActionEntrypoint,
  SecretScrubber,
  startNativePullRequestPublisherServer,
} from '../src/index.js';
import { git, readJsonBody, sseStop, sseToolCalls, startHttpServer } from './mcp-test-fixtures.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';

const fastAdapter = createFastTurnkeyAdapter();
const CONVENTIONAL_COMMIT_REGEX = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w\-./]+\))?(!)?: .+/;

describe('candidate PR formatting, operator/loopwright schemas, and memory commit conciseness', () => {
  it('renders gpustack-operator versions + metadata subscriptions without bogus runner table, diffs full digests, and folds unchanged rows', () => {
    const scrubber = new SecretScrubber();
    const digest = 'cafebabe12345678'.repeat(4);
    const baseShaSamePrefixA = 'abcdef123456' + '1'.repeat(28);
    const candShaSamePrefixB = 'abcdef123456' + '2'.repeat(28);
    const unchangedSha = '9999888877776666'.repeat(4);

    const baseProposal = {
      schema_version: 1,
      summary: 'Baseline operator chart and prior versions.',
      versions: {
        vllm: '0.18.0',
        sglang: baseShaSamePrefixA,
        'kube-prometheus-stack': '65.1.0',
        'legacy-addon': '1.2.3',
        stable: unchangedSha,
      },
      subscriptions: [
        { id: 'vllm', source: 'vllm-project/vllm', kind: 'github-release', version: '0.18.0' },
        { id: 'sglang', source: 'sglang-project/sglang', kind: 'git-commit', version: baseShaSamePrefixA },
        { id: 'kube-prometheus-stack', source: 'prometheus-community/helm-charts', chart: 'kube-prometheus-stack', version: '65.1.0' },
        { id: 'legacy-addon', source: 'acme/legacy-addon', version: '1.2.3' },
        { id: 'stable', source: 'acme/stable', version: unchangedSha },
      ],
    };

    const candProposal = {
      schema_version: 1,
      summary: 'Update vLLM and SGLang pins for operator release.',
      stage: 'aligned',
      notes: ['Verified helm template rendering.', 'Pinned SGLang commit SHA.'],
      versions: {
        vllm: '0.19.1',
        sglang: candShaSamePrefixB,
        'kube-prometheus-stack': '65.1.0',
        'new-plugin': '0.4.0',
        stable: unchangedSha,
      },
      subscriptions: [
        { id: 'vllm', source: 'vllm-project/vllm', kind: 'github-release', version: '0.19.1' },
        { id: 'sglang', source: 'sglang-project/sglang', kind: 'git-commit', version: candShaSamePrefixB },
        { id: 'kube-prometheus-stack', source: 'prometheus-community/helm-charts', chart: 'kube-prometheus-stack', version: '65.1.0' },
        { id: 'new-plugin', source: 'acme/new-plugin', version: '0.4.0' },
        { id: 'stable', source: 'acme/stable', version: unchangedSha },
      ],
    };

    const rendered = buildNativePullRequestBody({
      runId: 'run-op-1',
      candidateDigest: digest,
      proposalPath: '.autosync/priors.json',
      files: [{ name: '.autosync/priors.json', bytes: Buffer.from(JSON.stringify(candProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/priors.json']),
      baseProposalBytes: Buffer.from(JSON.stringify(baseProposal), 'utf8'),
      modifiedPaths: ['.autosync/priors.json', 'charts/operator/Chart.yaml'],
      scrubber,
    });

    assert.equal(rendered.includes('| Subscription | Status | Engine | Plugin | Reason |'), false, rendered);
    assert.ok(rendered.includes('## Summary'), rendered);
    assert.ok(rendered.includes('- **Stage**: `aligned`'), rendered);
    assert.ok(rendered.includes('- **Notes**:\n  - Verified helm template rendering.\n  - Pinned SGLang commit SHA.'), rendered);
    assert.ok(rendered.includes('## Version Changes'), rendered);
    assert.ok(rendered.includes('| Component | Source | Previous | Target | Status |'), rendered);
    assert.ok(rendered.includes('| `vllm` | `vllm-project/vllm` | `0.18.0` | `0.19.1` | Updated |'), rendered);
    assert.ok(rendered.includes('| `sglang` | `sglang-project/sglang` | `abcdef123456` | `abcdef123456` | Updated |'), rendered);
    assert.ok(rendered.includes('| `new-plugin` | `acme/new-plugin` | - | `0.4.0` | Added |'), rendered);
    assert.ok(rendered.includes('| `legacy-addon` | `acme/legacy-addon` | `1.2.3` | - | Removed |'), rendered);
    assert.ok(rendered.includes('<details>\n<summary>Unchanged tracked versions (2)</summary>'), rendered);
    assert.ok(rendered.includes('| `kube-prometheus-stack` | `prometheus-community/helm-charts` | `65.1.0` | `65.1.0` | Unchanged |'), rendered);
    assert.ok(rendered.includes('| `stable` | `acme/stable` | `999988887777` | `999988887777` | Unchanged |'), rendered);
    assert.ok(rendered.includes('## Modified Files (2)\n\n- `.autosync/priors.json`\n- `charts/operator/Chart.yaml`'), rendered);
    assert.ok(rendered.endsWith('\n\n---\n\nAutomated Loopwright update for run `run-op-1` (`cafebabe1234`).'), rendered);

    // When all versions are unchanged, render direct table with note (no <details> folding).
    const allMatch = buildNativePullRequestBody({
      runId: 'run-op-2',
      candidateDigest: digest,
      proposalPath: '.autosync/priors.json',
      files: [{ name: '.autosync/priors.json', bytes: Buffer.from(JSON.stringify(baseProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/priors.json']),
      baseProposalBytes: Buffer.from(JSON.stringify(baseProposal), 'utf8'),
      scrubber,
    });
    assert.ok(allMatch.includes('_All 5 tracked versions match base._'), allMatch);
    assert.equal(allMatch.includes('<details>'), false, allMatch);
  });

  it('renders loopwright upstreams schema with Previous -> Target diffing and grouped >15 modifiedPaths', () => {
    const scrubber = new SecretScrubber();
    const digest = '1122334455667788'.repeat(4);
    const baseUpstreams = {
      schema_version: 1,
      summary: 'Baseline Loopwright dependencies.',
      upstreams: {
        'pi-coding-agent': { package: '@earendil-works/pi-coding-agent', version: '1.5.0' },
        yaml: { package: 'yaml', version: '2.9.0' },
      },
    };
    const candUpstreams = {
      schema_version: 1,
      summary: 'Upgrade @earendil-works/pi-coding-agent to 1.5.2.',
      notes: 'All unit suites verified.',
      upstreams: {
        'pi-coding-agent': { package: '@earendil-works/pi-coding-agent', version: '1.5.2' },
        yaml: { package: 'yaml', version: '2.9.0' },
      },
    };
    const manyFiles = [
      'package.json',
      ...Array.from({ length: 12 }, (_, idx) => `packages/agent-pi/src/file-${idx}.ts`),
      ...Array.from({ length: 8 }, (_, idx) => `docs/guide-${idx}.md`),
    ];
    const rendered = buildNativePullRequestBody({
      runId: 'run-lw-1',
      candidateDigest: digest,
      proposalPath: '.loopwright/proposal.json',
      files: [{ name: '.loopwright/proposal.json', bytes: Buffer.from(JSON.stringify(candUpstreams), 'utf8') }],
      stagedPaths: new Set(['.loopwright/proposal.json']),
      baseProposalBytes: Buffer.from(JSON.stringify(baseUpstreams), 'utf8'),
      modifiedPaths: manyFiles,
      scrubber,
    });

    assert.ok(rendered.includes('- **Notes**: All unit suites verified.'), rendered);
    assert.ok(rendered.includes('| Upstream | Package | Previous | Target | Status |'), rendered);
    assert.ok(rendered.includes('| `pi-coding-agent` | `@earendil-works/pi-coding-agent` | `1.5.0` | `1.5.2` | Updated |'), rendered);
    assert.ok(rendered.includes('<details>\n<summary>Unchanged tracked upstream pins (1)</summary>'), rendered);
    assert.ok(rendered.includes('| `yaml` | `yaml` | `2.9.0` | `2.9.0` | Unchanged |'), rendered);
    assert.ok(rendered.includes('## Modified Files (21)'), rendered);
    assert.ok(rendered.includes('- `(root)`: 1 file'), rendered);
    assert.ok(rendered.includes('- `docs/`: 8 files'), rendered);
    assert.ok(rendered.includes('- `packages/`: 12 files'), rendered);
    assert.ok(rendered.includes('<summary>View modified files (21)</summary>'), rendered);

    // Without baseProposalBytes, omits Previous/Status columns
    const noBase = buildNativePullRequestBody({
      runId: 'run-lw-2',
      candidateDigest: digest,
      proposalPath: '.loopwright/proposal.json',
      files: [{ name: '.loopwright/proposal.json', bytes: Buffer.from(JSON.stringify(candUpstreams), 'utf8') }],
      stagedPaths: new Set(['.loopwright/proposal.json']),
      scrubber,
    });
    assert.ok(noBase.includes('| Upstream | Package | Target |'), noBase);
    assert.ok(noBase.includes('| `pi-coding-agent` | `@earendil-works/pi-coding-agent` | `1.5.2` |'), noBase);
    assert.equal(noBase.includes('Previous'), false, noBase);
  });

  it('scrubs 64-hex secrets before 12-hex slicing, preserves literal `<details>` in untruncated bodies, and cleans up truncated `<details>`', () => {
    const scrubber = new SecretScrubber();
    const hexSecret64 = 'a1b2c3d4e5f60718'.repeat(4);
    const pipeSecret = 'tok|pipe\\secret`tick';
    scrubber.register(hexSecret64);
    scrubber.register(pipeSecret);
    const digest = '1122334455667788'.repeat(4);

    // 1) 64-hex secret in versions/upstreams must become [REDACTED], NOT sliced to 12 hex chars!
    const secretProposal = {
      schema_version: 1,
      summary: 'Contains literal `<details>` tag in summary without a collapsible block.',
      versions: {
        vllm: hexSecret64,
        sglang: '0.5.9',
      },
      upstreams_ignored_note: pipeSecret,
      subscriptions: [
        { id: 'vllm', source: `repo/${pipeSecret}`, version: hexSecret64 },
      ],
    };
    const secretRendered = buildNativePullRequestBody({
      runId: 'run-sec-1',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(secretProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      modifiedPaths: ['pack/file.txt'],
      scrubber,
    });
    assert.equal(secretRendered.includes(hexSecret64.slice(0, 12)), false, '12-hex prefix of 64-hex secret must not leak');
    assert.equal(secretRendered.includes(pipeSecret), false);
    assert.ok(secretRendered.includes('| `vllm` | `repo/[scrubbed]` | `[scrubbed]` |'), secretRendered);
    // Literal `<details>` in summary must NOT truncate ## Version Changes or ## Modified Files when within budget!
    assert.ok(secretRendered.includes('## Summary'), secretRendered);
    assert.ok(secretRendered.includes('## Version Changes'), secretRendered);
    assert.ok(secretRendered.includes('## Modified Files (1)'), secretRendered);

    // 2) Truncation (> 32,000 code points) cutting across <details> leaves zero unclosed <details tags and ends with provenanceFooter
    const manyUnchanged: Record<string, string> = {};
    for (let i = 0; i < 400; i += 1) {
      manyUnchanged[`component-${String(i).padStart(3, '0')}`] = `1.0.${i}-long-suffix-${'x'.repeat(40)}`;
    }
    const baseMany: Record<string, string> = { ...manyUnchanged, 'changed-item': '1.0.0' };
    const candMany: Record<string, string> = { ...manyUnchanged, 'changed-item': '2.0.0' };
    const truncatedRendered = buildNativePullRequestBody({
      runId: 'run-trunc-details',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{
        name: '.autosync/proposal.json',
        bytes: Buffer.from(JSON.stringify({ summary: 'Big version table.', versions: candMany }), 'utf8'),
      }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      baseProposalBytes: Buffer.from(JSON.stringify({ summary: 'Big version table.', versions: baseMany }), 'utf8'),
      scrubber,
    });
    assert.ok(Array.from(truncatedRendered).length <= 32_000);
    assert.ok(truncatedRendered.endsWith('Automated Loopwright update for run `run-trunc-details` (`112233445566`).'));
    const openMatches = truncatedRendered.match(/<details\b/g) ?? [];
    const closeMatches = truncatedRendered.match(/<\/details>/g) ?? [];
    assert.equal(openMatches.length, closeMatches.length, 'must have balanced <details> tags after truncation');
    assert.equal(/<[a-z/!][^>]*$/i.test(truncatedRendered.split('\n\n---\n\n')[0]!), false, 'must not leave incomplete trailing HTML tag');
  });

  it('automatically loads baseProposalBytes from baseRevision, populates modifiedPaths, uses Conventional Commit fallback title, and keeps memory git commit concise', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-pr-fmt-e2e-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubApiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true });
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });

      const baseProposal = {
        schema_version: 1,
        summary: 'Baseline operator versions.',
        versions: {
          vllm: '0.18.0',
          sglang: '0.5.8',
        },
        subscriptions: [
          { id: 'vllm', source: 'vllm-project/vllm', version: '0.18.0' },
          { id: 'sglang', source: 'sglang-project/sglang', version: '0.5.8' },
        ],
      };
      await writeFile(join(repo, '.auto-sync', 'proposal.json'), `${JSON.stringify(baseProposal, null, 2)}\n`, 'utf8');
      await writeFile(join(repo, 'pack', 'pin.txt'), '0.18.0\n', 'utf8');
      await writeFile(join(repo, 'pack', 'mode-only.sh'), '#!/bin/sh\necho ok\n', { mode: 0o644 });
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), '#!/bin/sh\ngrep -q "0.19.1" .auto-sync/proposal.json\n', { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      const candProposal = {
        schema_version: 1,
        summary: 'Sync vLLM to 0.19.1.',
        stage: 'aligned',
        versions: {
          vllm: '0.19.1',
          sglang: '0.5.8',
        },
        subscriptions: [
          { id: 'vllm', source: 'vllm-project/vllm', version: '0.19.1' },
          { id: 'sglang', source: 'sglang-project/sglang', version: '0.5.8' },
        ],
      };

      let turn = 0;
      openAiServer = await startHttpServer(async (_req, res) => {
        const currentTurn = turn++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (currentTurn === 0) {
          res.end(sseToolCalls('gpt-4.1-mini', 'c1', [
            {
              id: 'w1',
              name: 'write',
              args: { path: '.auto-sync/proposal.json', content: `${JSON.stringify(candProposal, null, 2)}\n` },
            },
            {
              id: 'w2',
              name: 'write',
              args: { path: 'pack/pin.txt', content: '0.19.1\n' },
            },
          ]));
          return;
        }
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [],
          reason: 'Updated vLLM to 0.19.1.',
        })));
      });

      const createdCandidatePrs: Array<{ readonly title: string; readonly body: string }> = [];
      const createdMemoryPrs: Array<{ readonly title: string; readonly body: string }> = [];
      githubApiServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/repos/acme/operator') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 901, full_name: 'acme/operator', default_branch: 'main' }));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/repos/acme/operator/pulls') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('[]');
          return;
        }
        if (req.method === 'POST' && url.pathname === '/repos/acme/operator/pulls') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          const prRecord = { title: String(payload['title'] ?? ''), body: String(payload['body'] ?? '') };
          if (headRef.startsWith('loopwright/memory/')) {
            createdMemoryPrs.push(prRecord);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ number: 52, html_url: 'https://github.invalid/acme/operator/pull/52' }));
            return;
          }
          createdCandidatePrs.push(prRecord);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 51, html_url: 'https://github.invalid/acme/operator/pull/51' }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
      });

      // Note: omit titleTemplate so publisher exercises fallback Conventional Commit title!
      await writeFile(
        join(repo, '.auto-sync', 'taskpack.yaml'),
        `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: operator-sync
spec:
  goal:
    candidate: Sync operator pins.
    noChange: Confirm operator pins are current.
  scope:
    writable:
      - .auto-sync/proposal.json
      - 'pack/**'
  upstreams:
    - id: vllm
      kind: custom-table
      source: versions
      watchedPaths: []
  proposal:
    path: .auto-sync/proposal.json
    requiredFields:
      - schema_version
      - summary
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-json
        implementation: json-artifact.v1
        parameters:
          path: .auto-sync/proposal.json
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 10
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore(operator): sync pins"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiServer.url}/v1
      cost:
        input: 1
        output: 2
`,
        'utf8',
      );
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'chore: bootstrap operator repo']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      // Advance sourceRevision with a mode-only change (100644 -> 100755, same blob OID) on pack/mode-only.sh
      await git(repo, ['update-index', '--chmod=+x', 'pack/mode-only.sh']);
      await git(repo, ['commit', '-m', 'chore: mark pack/mode-only.sh executable']);
      const sourceSha = await git(repo, ['rev-parse', 'HEAD']);

      const longRunId = 'run-op-e2e-' + 'x'.repeat(50);
      const actionRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/operator',
        repositoryId: 901,
        baseRevision: headSha,
        sourceRevision: sourceSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: longRunId,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        gitRemoteUrl: bareRemote,
        githubApiBaseUrl: githubApiServer.url,
        githubToken: 'ghp_test_operator_token_1234',
        upstreamRecords: [{ upstreamId: 'vllm', status: 'available', version: '0.19.1' }],
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          LLM_TOKEN: 'sk-test-operator-llm-1234',
        },
      });
      assert.equal(actionRes.kind, 'compiled', JSON.stringify(actionRes));
      if (actionRes.kind === 'compiled') {
        assert.equal(actionRes.delegateOutcome?.ok, true, actionRes.delegateOutcome?.detail ?? '');
      }

      // 1) Candidate PR uses baseProposalBytes from git & modifiedPaths (including mode-only 100644 -> 100755)
      assert.equal(createdCandidatePrs.length, 1);
      const candPr = createdCandidatePrs[0]!;
      assert.ok(candPr.body.includes('## Summary'), candPr.body);
      assert.ok(candPr.body.includes('- **Stage**: `aligned`'), candPr.body);
      assert.ok(candPr.body.includes('| Component | Source | Previous | Target | Status |'), candPr.body);
      assert.ok(candPr.body.includes('| `vllm` | `vllm-project/vllm` | `0.18.0` | `0.19.1` | Updated |'), candPr.body);
      assert.ok(candPr.body.includes('<summary>Unchanged tracked versions (1)</summary>'), candPr.body);
      assert.ok(
        candPr.body.includes('## Modified Files (3)\n\n- `.auto-sync/proposal.json`\n- `pack/mode-only.sh`\n- `pack/pin.txt`'),
        candPr.body,
      );
      assert.equal(candPr.body.includes('| Subscription | Status | Engine | Plugin | Reason |'), false, candPr.body);

      // 2) Exercise fallback Conventional Commit title (<= 72 chars) AND title secret scrubbing via startNativePullRequestPublisherServer
      const inspectDir = join(work, 'inspect-fallback-title');
      const inspected = await inspectRun({ runRoot, runId: longRunId, output: inspectDir });
      assert.equal(inspected.ok, true);
      const resultDoc = JSON.parse(await readFile(join(inspectDir, 'result.json'), 'utf8')) as {
        spec: { subject: { candidateDigest: { hex: string } } };
      };
      const titleSecret = 'ghp_title_secret_leak_check_999999';
      const pubScrubber = new SecretScrubber();
      pubScrubber.register(titleSecret);
      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/operator',
        targetBranch: 'main',
        headBranchPrefix: 'fallback-title/',
        remoteUrl: bareRemote,
        apiBaseUrl: githubApiServer.url,
        gitWriteToken: 'ghp_test_operator_token_1234',
        proposalPath: '.auto-sync/proposal.json',
        scrubber: pubScrubber,
      });
      const rawPubReq = Buffer.from(JSON.stringify({
        storeId: 'store-1',
        runId: longRunId,
        operationId: 'op-1',
        dispatchId: 'disp-1',
        dispatchGeneration: 1,
        idempotencyKey: 'idem-fallback-1',
        candidateDigest: resultDoc.spec.subject.candidateDigest.hex,
        baseRevision: headSha,
        sourceRevision: sourceSha,
        targetBranch: 'main',
      }), 'utf8');
      const pubHttpRes = await fetch(pubServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${pubServer.authToken}`,
          'x-loopwright-signature': signPayload(pubServer.signingSecret, rawPubReq),
        },
        body: rawPubReq,
      });
      assert.equal(pubHttpRes.status, 200);
      assert.equal(createdCandidatePrs.length, 2);
      const fallbackPr = createdCandidatePrs[1]!;
      assert.ok(Array.from(fallbackPr.title).length <= 72, `expected <= 72 chars, got ${fallbackPr.title.length}: ${fallbackPr.title}`);
      assert.equal(fallbackPr.title, `chore(loopwright): automated update (${longRunId.slice(0, 34)})`);
      assert.match(fallbackPr.title, CONVENTIONAL_COMMIT_REGEX);

      // Also verify secret passed in request['title'] is scrubbed in both git commit log and GitHub PR title
      await pubServer.close();
      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/operator',
        targetBranch: 'main',
        headBranchPrefix: 'scrub-title/',
        remoteUrl: bareRemote,
        apiBaseUrl: githubApiServer.url,
        gitWriteToken: 'ghp_test_operator_token_1234',
        proposalPath: '.auto-sync/proposal.json',
        scrubber: pubScrubber,
      });
      const rawScrubReq = Buffer.from(JSON.stringify({
        storeId: 'store-2',
        runId: longRunId,
        operationId: 'op-2',
        dispatchId: 'disp-2',
        dispatchGeneration: 1,
        idempotencyKey: 'idem-scrub-title-1',
        candidateDigest: resultDoc.spec.subject.candidateDigest.hex,
        baseRevision: headSha,
        sourceRevision: sourceSha,
        targetBranch: 'main',
        title: `chore(sync): update with ${titleSecret}`,
      }), 'utf8');
      const scrubHttpRes = await fetch(pubServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${pubServer.authToken}`,
          'x-loopwright-signature': signPayload(pubServer.signingSecret, rawScrubReq),
        },
        body: rawScrubReq,
      });
      assert.equal(scrubHttpRes.status, 200);
      assert.equal(createdCandidatePrs.length, 3);
      const scrubbedPr = createdCandidatePrs[2]!;
      assert.equal(scrubbedPr.title.includes(titleSecret), false);
      assert.equal(scrubbedPr.title, 'chore(sync): update with [scrubbed]');
      const scrubClone = join(work, 'scrub-title-clone');
      await git(work, ['clone', '--branch', 'scrub-title/main', bareRemote, scrubClone]);
      const scrubCommitMsg = await git(scrubClone, ['log', '-1', '--format=%B']);
      assert.equal(scrubCommitMsg.includes(titleSecret), false);
      assert.ok(scrubCommitMsg.includes('chore(sync): update with [scrubbed]'), scrubCommitMsg);

      // 3) Memory PR from runGitHubActionEntrypoint: GitHub API gets rich Markdown body & Conventional Commit title, while git commit-tree gets concise plain-text bullets
      assert.equal(createdMemoryPrs.length, 1);
      const memPr = createdMemoryPrs[0]!;
      assert.equal(memPr.title, 'chore(memory): record 2 verified operator-sync entries');
      assert.match(memPr.title, CONVENTIONAL_COMMIT_REGEX);
      assert.ok(memPr.body.includes('## Summary'), memPr.body);
      assert.ok(memPr.body.includes('## Memory Changes'), memPr.body);
      assert.ok(memPr.body.includes('| Action | Kind | Entry | Claim / Reason | Evidence |'), memPr.body);
      assert.ok(memPr.body.includes('<summary>Provenance & Evidence Receipts ('), memPr.body);

      const memClone = join(work, 'mem-commit-check');
      await git(work, ['clone', '--branch', 'loopwright/memory/operator-sync/main', bareRemote, memClone]);
      const memCommitMsg = await git(memClone, ['log', '-1', '--format=%B']);
      const commitLines = memCommitMsg.split(/\r?\n/);
      assert.equal(commitLines[0], 'chore(memory): record 2 verified operator-sync entries');
      assert.ok(memCommitMsg.includes('- Taskpack: operator-sync'), memCommitMsg);
      assert.ok(memCommitMsg.includes('- Operations: 2 (2 upsert, 0 retire)'), memCommitMsg);
      assert.ok(memCommitMsg.includes(`- Run: ${longRunId.slice(0, 65)}`), memCommitMsg);
      assert.ok(memCommitMsg.includes('Signed-off-by: '), memCommitMsg);
      assert.equal(memCommitMsg.includes('| Action | Kind |'), false, 'git commit message must stay concise without PR Markdown table');
      assert.equal(memCommitMsg.includes('<details>'), false, 'git commit message must stay concise without HTML details');
    } finally {
      await pubServer?.close();
      await openAiServer?.close();
      await githubApiServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('keeps standalone metadata-only subscriptions tables, preserves distinct secret-keyed rows, and caps orderedKeys union at 500', () => {
    const scrubber = new SecretScrubber();
    const secretA = 'secret-alpha-token-value-1111';
    const secretB = 'secret-bravo-token-value-2222';
    scrubber.register(secretA);
    scrubber.register(secretB);
    const digest = 'deadbeefcafebabe'.repeat(4);

    // 1) Standalone subscriptions-only proposal without RUNNER_SUBSCRIPTION_KEYS still renders Subscriptions table
    const standaloneSubs = {
      schema_version: 1,
      summary: 'Metadata-only subscriptions proposal.',
      subscriptions: [
        { id: 'vllm', source: 'vllm-project/vllm', version: '0.19.1' },
      ],
    };
    const standaloneBody = buildNativePullRequestBody({
      runId: 'run-sub-only',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(standaloneSubs), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(standaloneBody.includes('## Subscriptions'), standaloneBody);
    assert.ok(standaloneBody.includes('| vllm | - | - | - | - |'), standaloneBody);

    // 2) Two upstream IDs containing two distinct secrets stay separate [scrubbed] rows and diff raw values accurately
    const baseSecretUpstreams = {
      schema_version: 1,
      upstreams: {
        [`upstream-${secretA}`]: { package: 'pkg-a', version: secretA },
        [`upstream-${secretB}`]: { package: 'pkg-b', version: secretA },
      },
    };
    const candSecretUpstreams = {
      schema_version: 1,
      upstreams: {
        [`upstream-${secretA}`]: { package: 'pkg-a', version: secretA },
        [`upstream-${secretB}`]: { package: 'pkg-b', version: secretB },
      },
    };
    const secretRowsBody = buildNativePullRequestBody({
      runId: 'run-secret-keys',
      candidateDigest: digest,
      proposalPath: '.loopwright/proposal.json',
      files: [{ name: '.loopwright/proposal.json', bytes: Buffer.from(JSON.stringify(candSecretUpstreams), 'utf8') }],
      stagedPaths: new Set(['.loopwright/proposal.json']),
      baseProposalBytes: Buffer.from(JSON.stringify(baseSecretUpstreams), 'utf8'),
      scrubber,
    });
    assert.equal(secretRowsBody.includes(secretA), false);
    assert.equal(secretRowsBody.includes(secretB), false);
    assert.ok(secretRowsBody.includes('| `upstream-[scrubbed]` | `pkg-b` | `[scrubbed]` | `[scrubbed]` | Updated |'), secretRowsBody);
    assert.ok(secretRowsBody.includes('| `upstream-[scrubbed]` | `pkg-a` | `[scrubbed]` | `[scrubbed]` | Unchanged |'), secretRowsBody);

    // 3) Union of candidate + base-only keys is capped at 500 with singular/plural omitted entry notices
    const baseUnion: Record<string, string> = {};
    const candUnion: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) {
      candUnion[`cand-${String(i).padStart(3, '0')}`] = '1.0.0';
      baseUnion[`base-${String(i).padStart(3, '0')}`] = '1.0.0';
    }
    const unionBody = buildNativePullRequestBody({
      runId: 'run-union-cap',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify({ versions: candUnion }), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      baseProposalBytes: Buffer.from(JSON.stringify({ versions: baseUnion }), 'utf8'),
      scrubber,
    });
    assert.ok(unionBody.includes('_...and 100 additional version entries omitted._'), unionBody);
    const renderedTableRows = unionBody.split('\n').filter(line => line.startsWith('| `cand-') || line.startsWith('| `base-'));
    assert.equal(renderedTableRows.length, 500);

    const cand500: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) {
      cand500[`cand-${String(i).padStart(3, '0')}`] = '1.0.0';
    }
    const singleOmitBody = buildNativePullRequestBody({
      runId: 'run-union-cap-1',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify({ versions: cand500 }), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      baseProposalBytes: Buffer.from(JSON.stringify({ versions: { 'removed-only': '0.9.0' } }), 'utf8'),
      scrubber,
    });
    assert.ok(singleOmitBody.includes('_...and 1 additional version entry omitted._'), singleOmitBody);
  });

  it('escapes Markdown/HTML injection in proposal notes, neutralizes trailing backslashes in inline code, aligns subscription ID precedence, and tracks >10,000 modifiedPaths', () => {
    const scrubber = new SecretScrubber();
    const digest = '0011223344556677'.repeat(4);

    // 1) Untrusted string and array notes cannot inject headings, links, horizontal rules, or raw HTML
    const injectionStrProposal = {
      schema_version: 1,
      summary: 'Safe summary.',
      stage: 'aligned\\stage`test\\',
      notes: '# Fake Heading\n[evil](https://evil.example) <script>alert(1)</script>\n---',
    };
    const strNotesBody = buildNativePullRequestBody({
      runId: 'run-notes-str',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(injectionStrProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      modifiedPaths: ['dir\\sub\\file.ts\\'],
      scrubber,
    });
    assert.ok(strNotesBody.includes('- **Stage**: `aligned/stage\'test/`'), strNotesBody);
    assert.ok(strNotesBody.includes('- `dir/sub/file.ts/`'), strNotesBody);
    assert.ok(
      strNotesBody.includes('- **Notes**: \\# Fake Heading \\[evil\\](https://evil.example) &lt;script&gt;alert(1)&lt;/script&gt; ---'),
      strNotesBody,
    );
    assert.equal(strNotesBody.includes('<script>'), false);
    assert.equal(/^# Fake Heading/m.test(strNotesBody), false);
    assert.equal(/\[evil\]\(https:\/\/evil\.example\)/.test(strNotesBody), false);

    const injectionArrProposal = {
      schema_version: 1,
      summary: 'Safe summary.',
      notes: [
        '# Fake Heading\n[evil](https://evil.example) <script>',
        '---\n*bold* _italic_ `code` |pipe|\\slash',
      ],
    };
    const arrNotesBody = buildNativePullRequestBody({
      runId: 'run-notes-arr',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(injectionArrProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(
      arrNotesBody.includes('  - \\# Fake Heading \\[evil\\](https://evil.example) &lt;script&gt;'),
      arrNotesBody,
    );
    assert.ok(
      arrNotesBody.includes('  - \\--- \\*bold\\* \\_italic\\_ \\`code\\` \\|pipe\\|\\\\slash'),
      arrNotesBody,
    );
    assert.equal(arrNotesBody.includes('<script>'), false);
    assert.equal(/^---$/m.test(arrNotesBody.split('\n\n---\n\n')[0]!), false);

    // 1b) Ampersands in notes are escaped to &amp; before truncation, and mid-&amp; truncation strips only the incomplete entity
    const ampProposal = {
      schema_version: 1,
      summary: 'Safe summary.',
      notes: 'R&D &',
    };
    const ampBody = buildNativePullRequestBody({
      runId: 'run-notes-amp',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(ampProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(ampBody.includes('- **Notes**: R&amp;D &amp;'), ampBody);

    const ampTruncatedProposal = {
      schema_version: 1,
      summary: 'Safe summary.',
      notes: `R&D ${'x'.repeat(1990)}&`,
    };
    const ampTruncatedBody = buildNativePullRequestBody({
      runId: 'run-notes-amp-trunc',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(ampTruncatedProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(ampTruncatedBody.includes(`- **Notes**: R&amp;D ${'x'.repeat(1990)}\n`), ampTruncatedBody);
    assert.equal(ampTruncatedBody.includes('&a\n'), false);

    // 2) Subscription identifier precedence: `subscription` takes precedence over `id` and `name` in both Version Changes Source lookup and Subscriptions table
    const precedenceProposal = {
      schema_version: 1,
      versions: {
        'rocm/sglang': '0.5.9',
      },
      subscriptions: [
        { subscription: 'rocm/sglang', id: 'legacy-id', name: 'legacy-name', source: 'sglang-project/sglang', status: 'ready' },
      ],
    };
    const precedenceBody = buildNativePullRequestBody({
      runId: 'run-sub-prec',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify(precedenceProposal), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      scrubber,
    });
    assert.ok(precedenceBody.includes('| `rocm/sglang` | `sglang-project/sglang` | `0.5.9` |'), precedenceBody);
    assert.ok(precedenceBody.includes('| rocm/sglang | ready | - | - | - |'), precedenceBody);

    // 3) >10,000 modifiedPaths reports bounded count+ and explicit omitted count
    const overCapPaths = Array.from({ length: 10_005 }, (_, i) => `packages/pkg-${i % 10}/file-${i}.ts`);
    const overCapBody = buildNativePullRequestBody({
      runId: 'run-paths-cap',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify({ summary: 'Many files.' }), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      modifiedPaths: overCapPaths,
      scrubber,
    });
    assert.ok(overCapBody.includes('## Modified Files (10000+)'), overCapBody);
    assert.ok(overCapBody.includes('<summary>View modified files (10000+)</summary>'), overCapBody);
    assert.ok(overCapBody.includes('_...and 5 additional paths omitted._'), overCapBody);

    const singleOmitPaths = Array.from({ length: 10_001 }, (_, i) => `packages/file-${i}.ts`);
    const singleOmitPathsBody = buildNativePullRequestBody({
      runId: 'run-paths-cap-1',
      candidateDigest: digest,
      proposalPath: '.autosync/proposal.json',
      files: [{ name: '.autosync/proposal.json', bytes: Buffer.from(JSON.stringify({ summary: 'Many files.' }), 'utf8') }],
      stagedPaths: new Set(['.autosync/proposal.json']),
      modifiedPaths: singleOmitPaths,
      scrubber,
    });
    assert.ok(singleOmitPathsBody.includes('_...and 1 additional path omitted._'), singleOmitPathsBody);
  });

  it('streams a 68 MiB (> 64 MiB) v2 CAS blob in 1 MiB chunks via a single O_NOFOLLOW fd into git hash-object, preserves 100755 mode, and refuses tampered/hardlinked/writable/cross-run CAS blobs', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-pub-cas-68m-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let githubApiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['config', 'user.name', 'Test User']);
      await git(repo, ['config', 'user.email', 'test@example.com']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await mkdir(join(repo, '.loopwright'), { recursive: true });
      await mkdir(join(repo, 'assets'), { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await writeFile(
        join(repo, '.loopwright', 'proposal.json'),
        JSON.stringify({ schema_version: 1, summary: 'Baseline.', versions: { bundle: '1.0.0' } }) + '\n',
        'utf8',
      );
      const taskpackObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'cas-68m-pub' },
        spec: {
          goal: { candidate: 'Stream 68 MiB asset and script.', noChange: 'None.' },
          scope: {
            writable: ['.loopwright/proposal.json', 'assets/**', 'scripts/**'],
            protected: [],
          },
          proposal: {
            path: '.loopwright/proposal.json',
            requiredFields: ['schema_version', 'summary'],
            schemaVersion: 1,
          },
          upstreams: [],
          roles: [
            { id: 'implementer', purpose: 'task', provider: 'antigravity', model: 'gemini-4-carbon' },
          ],
          steps: [
            { id: 'implement', kind: 'agent', role: 'implementer', dependsOn: [] },
          ],
          limits: {
            overlay: { maxFiles: 64, maxBytes: 134_217_728 },
          },
          verification: {
            localChecks: [
              { id: 'prop-json', implementation: 'json-artifact.v1', parameters: { path: '.loopwright/proposal.json' } },
            ],
            externalGates: [],
          },
          publication: {
            mode: 'disabled',
          },
        },
      };
      await writeFile(join(repo, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(taskpackObj), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'initial']);
      const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['push', 'origin', 'main']);

      const runId = 'cas-68m-run';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repo,
        runRoot,
        runId,
        policyProfile: 'github',
        discoverUpstreams: false,
      });
      const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId });
      assert.notEqual(gateHandle, null);

      const totalLargeBytes = 68 * 1024 * 1024; // 71,303,168 bytes (> 64 MiB)
      const chunk1MiB = Buffer.alloc(1024 * 1024, 0x5a);
      chunk1MiB.write('LOOPWRIGHT_CAS_68MIB_HEADER', 0, 'utf8');
      const expectedSha256Hasher = createHash('sha256');
      const expectedGitBlobHasher = createHash('sha1').update(`blob ${totalLargeBytes}\0`);
      for (let i = 0; i < 68; i += 1) {
        expectedSha256Hasher.update(chunk1MiB);
        expectedGitBlobHasher.update(chunk1MiB);
      }
      const expectedLargeSha256 = expectedSha256Hasher.digest('hex');
      const expectedLargeGitOid = expectedGitBlobHasher.digest('hex');

      const prevGateEnv = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
      process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle!.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
      let candidateDigest = '';
      try {
        const loaded = await loadTrustedConfiguration({
          configPath: staged.configPath,
          registryPath: staged.registryPath,
          registrySha256: staged.registrySha256,
          untrustedRoots: [repo],
        });
        assert.equal(loaded.ok, true);
        if (!loaded.ok) return;

        const firstTick = await stepNext(
          { configuration: loaded.value, repository: repo, runRoot, runId, environment: gateHandle!.environment },
          gateHandle!.ports,
        );
        assert.equal(firstTick.ok, true);
        if (!firstTick.ok || firstTick.value.kind !== 'step') {
          assert.fail(`expected step yield from stepNext: ${JSON.stringify(firstTick)}`);
        }

        // Stream-write 68 MiB file to candidateDir without allocating a 68 MiB Buffer
        await mkdir(join(firstTick.value.candidateDir, 'assets'), { recursive: true });
        const fh = await open(join(firstTick.value.candidateDir, 'assets', 'bundle.bin'), 'w', 0o600);
        try {
          for (let i = 0; i < 68; i += 1) {
            await fh.write(chunk1MiB, 0, chunk1MiB.byteLength, i * chunk1MiB.byteLength);
          }
        } finally {
          await fh.close();
        }
        await mkdir(join(firstTick.value.candidateDir, 'scripts'), { recursive: true });
        const deployScript = join(firstTick.value.candidateDir, 'scripts', 'deploy.sh');
        await writeFile(deployScript, '#!/usr/bin/env bash\necho deploy-ok\n', { mode: 0o755 });
        await chmod(deployScript, 0o755);

        await writeFile(
          join(firstTick.value.candidateDir, '.loopwright', 'proposal.json'),
          JSON.stringify({
            schema_version: 1,
            summary: 'Streamed 68 MiB asset cleanly.',
            versions: { bundle: '2.0.0' },
          }) + '\n',
          'utf8',
        );

        const submitted = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: firstTick.value.leaseToken,
            status: 'completed',
            reason: 'streamed 68 MiB asset',
            environment: gateHandle!.environment,
          },
          gateHandle!.ports,
        );
        assert.equal(submitted.ok, true, JSON.stringify(submitted));
        if (submitted.ok && submitted.value.kind === 'result') {
          assert.equal(submitted.value.result.spec.status, 'completed');
          candidateDigest = submitted.value.result.spec.subject.candidateDigest.hex;
        } else {
          assert.fail(`expected settled completed result, got ${JSON.stringify(submitted)}`);
        }
      } finally {
        if (prevGateEnv === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateEnv;
        await gateHandle!.close();
      }

      // Confirm inspectRun exports version: 2 CAS pointers
      const inspectCheckDir = join(work, 'inspect-check');
      const inspectCheck = await inspectRun({ runRoot, runId, output: inspectCheckDir });
      assert.equal(inspectCheck.ok, true);
      const exportedCandidateFiles = JSON.parse(await readFile(join(inspectCheckDir, 'candidate.files.json'), 'utf8')) as {
        version: number;
        files: Array<{ name: string; mode: string; sha256: string; byteLength: number; uri: string }>;
      };
      assert.equal(exportedCandidateFiles.version, 2);
      const bundleEntry = exportedCandidateFiles.files.find(f => f.name === 'assets/bundle.bin');
      assert.equal(bundleEntry?.sha256, expectedLargeSha256);
      assert.equal(bundleEntry?.byteLength, totalLargeBytes);

      const capturedPrRequests: Array<Record<string, unknown>> = [];
      githubApiServer = await startHttpServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/repos/acme/cas-repo/pulls') {
          const body = await readJsonBody(req);
          capturedPrRequests.push(body);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 101, html_url: 'https://github.invalid/acme/cas-repo/pull/101' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/cas-repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        proposalPath: '.loopwright/proposal.json',
        titleTemplate: 'feat(assets): publish 68 MiB CAS bundle',
        remoteUrl: bareRemote,
        apiBaseUrl: githubApiServer.url,
        gitWriteToken: 'ghs_cas_68m_secret_token_123456',
      });

      const postPublish = async (idempotencyKey: string) => {
        const payloadBytes = Buffer.from(JSON.stringify({
          storeId: 'store-cas',
          runId,
          operationId: `op-${idempotencyKey}`,
          dispatchId: `disp-${idempotencyKey}`,
          dispatchGeneration: 1,
          idempotencyKey,
          candidateDigest,
          baseRevision: baseSha,
          sourceRevision: baseSha,
          targetBranch: 'main',
        }), 'utf8');
        const res = await fetch(pubServer!.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-loopwright-signature': signPayload(pubServer!.signingSecret, payloadBytes),
            authorization: `Bearer ${pubServer!.authToken}`,
          },
          body: payloadBytes,
        });
        return {
          status: res.status,
          receipt: await res.json() as { outcome: string; externalUrl: string | null; reason: string | null },
        };
      };

      // 1) Anti-TOCTOU negative guards BEFORE valid publication pushes refs/heads/loopwright/main:
      const sha256BlobDir = join(runRoot, runId, 'artifacts', 'blobs', 'sha256');
      const casBlobPath = join(sha256BlobDir, expectedLargeSha256);

      // 1a) Hardlinked CAS blob (nlink > 1) -> refused before push
      const hardlinkSibling = join(work, 'hardlink-blob.bin');
      await chmod(sha256BlobDir, 0o700);
      await link(casBlobPath, hardlinkSibling);
      try {
        const hardlinkRes = await postPublish('idem-hardlink');
        assert.equal(hardlinkRes.receipt.outcome, 'not_executed', JSON.stringify(hardlinkRes.receipt));
      } finally {
        await unlink(hardlinkSibling);
      }

      // 1b) Writable CAS blob (0o644) -> refused before push
      await chmod(sha256BlobDir, 0o700);
      await chmod(casBlobPath, 0o644);
      try {
        const writableRes = await postPublish('idem-writable');
        assert.equal(writableRes.receipt.outcome, 'not_executed', JSON.stringify(writableRes.receipt));
      } finally {
        await chmod(sha256BlobDir, 0o700);
        await chmod(casBlobPath, 0o400);
      }

      // 1c) Tampered CAS blob bytes (same byteLength, flipped byte -> SHA-256 mismatch) -> refused before push
      const backupBlobPath = join(work, 'backup-cas-blob.bin');
      await chmod(sha256BlobDir, 0o700);
      await link(casBlobPath, backupBlobPath);
      await unlink(casBlobPath);
      const tamperedFh = await open(casBlobPath, 'w', 0o400);
      try {
        const badChunk = Buffer.from(chunk1MiB);
        badChunk[0] = 0xff;
        await tamperedFh.write(badChunk, 0, badChunk.byteLength, 0);
        for (let i = 1; i < 68; i += 1) {
          await tamperedFh.write(chunk1MiB, 0, chunk1MiB.byteLength, i * chunk1MiB.byteLength);
        }
        await tamperedFh.chmod(0o400);
      } finally {
        await tamperedFh.close();
      }
      try {
        const tamperedRes = await postPublish('idem-tampered');
        assert.equal(tamperedRes.receipt.outcome, 'not_executed', JSON.stringify(tamperedRes.receipt));
      } finally {
        await chmod(sha256BlobDir, 0o700);
        await unlink(casBlobPath);
        await link(backupBlobPath, casBlobPath);
        await unlink(backupBlobPath);
      }

      // 1d) Cross-run symlinked CAS blob -> refused before push
      const otherRunBlobDir = join(runRoot, 'other-run', 'artifacts', 'blobs', 'sha256');
      await mkdir(otherRunBlobDir, { recursive: true });
      const otherRunBlob = join(otherRunBlobDir, expectedLargeSha256);
      await writeFile(otherRunBlob, 'cross-run', { mode: 0o400 });
      const savedRealBlob = join(work, 'saved-real-blob.bin');
      await chmod(sha256BlobDir, 0o700);
      await link(casBlobPath, savedRealBlob);
      await unlink(casBlobPath);
      await symlink(otherRunBlob, casBlobPath);
      try {
        const crossRunRes = await postPublish('idem-cross-run');
        assert.equal(crossRunRes.receipt.outcome, 'not_executed', JSON.stringify(crossRunRes.receipt));
      } finally {
        await chmod(sha256BlobDir, 0o700);
        await unlink(casBlobPath);
        await link(savedRealBlob, casBlobPath);
        await unlink(savedRealBlob);
        await chmod(sha256BlobDir, 0o500);
      }

      assert.equal(
        (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).trim(),
        '',
        'no remote ref may be created when CAS guards reject tampered/hardlinked/writable/cross-run blobs',
      );

      // 2) Valid 68 MiB single-FD streaming publication succeeds, verifies Git OID, preserves 100755 mode, and formats PR body from proposal.json only!
      const okRes = await postPublish('idem-valid-68m');
      assert.equal(okRes.status, 200);
      assert.equal(okRes.receipt.outcome, 'succeeded', `expected succeeded, got: ${JSON.stringify(okRes.receipt)}`);
      assert.equal(okRes.receipt.externalUrl, 'https://github.invalid/acme/cas-repo/pull/101');

      const remoteHead = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).trim().split(/\s+/)[0]!;
      assert.match(remoteHead, /^[0-9a-f]{40}$/);
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);
      const treeLines = (await git(repo, ['ls-tree', '-r', '-l', '--full-tree', remoteHead])).trim().split('\n');
      const bundleTreeLine = treeLines.find(line => line.endsWith('\tassets/bundle.bin')) ?? '';
      const scriptTreeLine = treeLines.find(line => line.endsWith('\tscripts/deploy.sh')) ?? '';
      assert.match(bundleTreeLine, new RegExp(`^100644 blob ${expectedLargeGitOid}\\s+${totalLargeBytes}\\tassets/bundle\\.bin$`));
      assert.match(scriptTreeLine, /^100755 blob [0-9a-f]{40}\s+\d+\tscripts\/deploy\.sh$/);

      assert.equal(capturedPrRequests.length, 1);
      const renderedBody = String(capturedPrRequests[0]?.['body'] ?? '');
      assert.ok(renderedBody.includes('Streamed 68 MiB asset cleanly.'), renderedBody);
      assert.ok(renderedBody.includes('| `bundle` | `1.0.0` | `2.0.0` | Updated |'), renderedBody);
      assert.ok(renderedBody.includes('- `assets/bundle.bin`'), renderedBody);
      assert.ok(renderedBody.includes('- `scripts/deploy.sh`'), renderedBody);
    } finally {
      await pubServer?.close();
      await githubApiServer?.close();
      await makeTreeWritableForCleanup(work).catch(() => undefined);
      await rm(work, { recursive: true, force: true });
    }
  });

  it('honors explicit CAS v2 file.mode 100644 on classic snapshots even when baseline tracked the script as 100755', async () => {
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-pub-classic-mode-'));
    const work = await realpath(rawWork);
    const bareRemote = join(work, 'remote.git');
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let githubApiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      await mkdir(bareRemote, { recursive: true });
      await mkdir(repo, { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await git(bareRemote, ['init', '--bare', '--initial-branch=main']);
      await git(repo, ['init', '--initial-branch=main']);
      await git(repo, ['config', 'user.name', 'Test User']);
      await git(repo, ['config', 'user.email', 'test@example.com']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await mkdir(join(repo, '.loopwright'), { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      const clearedScript = join(repo, 'scripts', 'clear-exec.sh');
      const keptScript = join(repo, 'scripts', 'keep-exec.sh');
      await writeFile(clearedScript, '#!/usr/bin/env bash\necho old\n', { mode: 0o755 });
      await chmod(clearedScript, 0o755);
      await writeFile(keptScript, '#!/usr/bin/env bash\necho keep\n', { mode: 0o755 });
      await chmod(keptScript, 0o755);
      await writeFile(
        join(repo, '.loopwright', 'proposal.json'),
        JSON.stringify({ schema_version: 1, summary: 'Baseline.', versions: { scripts: '1.0.0' } }) + '\n',
        'utf8',
      );
      const taskpackObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'classic-mode-pub' },
        spec: {
          goal: { candidate: 'Clear executable bit on scripts/clear-exec.sh.', noChange: 'None.' },
          scope: {
            writable: ['.loopwright/proposal.json', 'scripts/**'],
            protected: [],
          },
          proposal: {
            path: '.loopwright/proposal.json',
            requiredFields: ['schema_version', 'summary'],
            schemaVersion: 1,
          },
          upstreams: [],
          roles: [
            { id: 'implementer', purpose: 'task', provider: 'antigravity', model: 'gemini-4-carbon' },
          ],
          steps: [
            { id: 'implement', kind: 'agent', role: 'implementer', dependsOn: [] },
          ],
          verification: {
            localChecks: [
              { id: 'prop-json', implementation: 'json-artifact.v1', parameters: { path: '.loopwright/proposal.json' } },
            ],
            externalGates: [],
          },
          publication: {
            mode: 'disabled',
          },
        },
      };
      await writeFile(join(repo, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(taskpackObj), 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'initial with 100755 scripts']);
      const baseSha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
      await git(repo, ['push', 'origin', 'main']);

      // Verify baseline tracks both scripts as 100755.
      const baseTreeLines = (await git(repo, ['ls-tree', '-r', '--full-tree', baseSha])).trim().split('\n');
      assert.match(baseTreeLines.find(line => line.endsWith('\tscripts/clear-exec.sh')) ?? '', /^100755 blob /);
      assert.match(baseTreeLines.find(line => line.endsWith('\tscripts/keep-exec.sh')) ?? '', /^100755 blob /);

      const runId = 'classic-mode-run';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repo,
        runRoot,
        runId,
        policyProfile: 'github',
        discoverUpstreams: false,
      });
      const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId });
      assert.notEqual(gateHandle, null);

      const prevGateEnv = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
      process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle!.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
      let candidateDigest = '';
      try {
        const loaded = await loadTrustedConfiguration({
          configPath: staged.configPath,
          registryPath: staged.registryPath,
          registrySha256: staged.registrySha256,
          untrustedRoots: [repo],
        });
        assert.equal(loaded.ok, true);
        if (!loaded.ok) return;

        const firstTick = await stepNext(
          { configuration: loaded.value, repository: repo, runRoot, runId, environment: gateHandle!.environment },
          gateHandle!.ports,
        );
        assert.equal(firstTick.ok, true);
        if (!firstTick.ok || firstTick.value.kind !== 'step') {
          assert.fail(`expected step yield from stepNext: ${JSON.stringify(firstTick)}`);
        }

        // Edit scripts/clear-exec.sh and explicitly clear its executable bit (0o644).
        const candidateCleared = join(firstTick.value.candidateDir, 'scripts', 'clear-exec.sh');
        await writeFile(candidateCleared, '#!/usr/bin/env bash\necho non-executable\n', { mode: 0o644 });
        await chmod(candidateCleared, 0o644);
        await writeFile(
          join(firstTick.value.candidateDir, '.loopwright', 'proposal.json'),
          JSON.stringify({
            schema_version: 1,
            summary: 'Clear executable bit on scripts/clear-exec.sh.',
            versions: { scripts: '1.0.1' },
          }) + '\n',
          'utf8',
        );

        const submitted = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: firstTick.value.leaseToken,
            status: 'completed',
            reason: 'cleared executable mode on script',
            environment: gateHandle!.environment,
          },
          gateHandle!.ports,
        );
        assert.equal(submitted.ok, true, JSON.stringify(submitted));
        if (submitted.ok && submitted.value.kind === 'result') {
          assert.equal(submitted.value.result.spec.status, 'completed');
          candidateDigest = submitted.value.result.spec.subject.candidateDigest.hex;
        } else {
          assert.fail(`expected settled completed result, got ${JSON.stringify(submitted)}`);
        }
      } finally {
        if (prevGateEnv === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateEnv;
        await gateHandle!.close();
      }

      // Confirm classic snapshot (baseTree === undefined) with CAS v2 mode: '100644'.
      const inspectCheckDir = join(work, 'inspect-check');
      const inspectCheck = await inspectRun({ runRoot, runId, output: inspectCheckDir });
      assert.equal(inspectCheck.ok, true);
      const exportedCandidateFiles = JSON.parse(await readFile(join(inspectCheckDir, 'candidate.files.json'), 'utf8')) as {
        version: number;
        manifest: { spec?: { baseTree?: unknown } };
        files: Array<{ name: string; mode: string; uri: string }>;
      };
      assert.equal(exportedCandidateFiles.manifest.spec?.baseTree, undefined, 'expected classic snapshot with baseTree === undefined');
      assert.equal(exportedCandidateFiles.version, 2);
      const clearedEntry = exportedCandidateFiles.files.find(f => f.name === 'scripts/clear-exec.sh');
      assert.equal(clearedEntry?.mode, '100644', 'CAS v2 candidate entry must carry mode 100644');
      const keptEntry = exportedCandidateFiles.files.find(f => f.name === 'scripts/keep-exec.sh');
      assert.equal(keptEntry?.mode, '100755', 'untouched executable script must remain mode 100755');

      githubApiServer = await startHttpServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/repos/acme/classic-mode-repo/pulls') {
          await readJsonBody(req);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 102, html_url: 'https://github.invalid/acme/classic-mode-repo/pull/102' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/classic-mode-repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        proposalPath: '.loopwright/proposal.json',
        titleTemplate: 'fix(scripts): clear executable bit on clear-exec.sh',
        remoteUrl: bareRemote,
        apiBaseUrl: githubApiServer.url,
        gitWriteToken: 'ghs_classic_mode_secret_token_123456',
      });

      const payloadBytes = Buffer.from(JSON.stringify({
        storeId: 'store-classic-mode',
        runId,
        operationId: 'op-classic-mode',
        dispatchId: 'disp-classic-mode',
        dispatchGeneration: 1,
        idempotencyKey: 'idem-classic-mode',
        candidateDigest,
        baseRevision: baseSha,
        sourceRevision: baseSha,
        targetBranch: 'main',
      }), 'utf8');
      const res = await fetch(pubServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-loopwright-signature': signPayload(pubServer.signingSecret, payloadBytes),
          authorization: `Bearer ${pubServer.authToken}`,
        },
        body: payloadBytes,
      });
      assert.equal(res.status, 200);
      const receipt = await res.json() as { outcome: string; reason: string | null };
      assert.equal(receipt.outcome, 'succeeded', JSON.stringify(receipt));

      const remoteHead = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).trim().split(/\s+/)[0]!;
      assert.match(remoteHead, /^[0-9a-f]{40}$/);
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);
      const publishedTreeLines = (await git(repo, ['ls-tree', '-r', '-l', '--full-tree', remoteHead])).trim().split('\n');
      const publishedClearedLine = publishedTreeLines.find(line => line.endsWith('\tscripts/clear-exec.sh')) ?? '';
      const publishedKeptLine = publishedTreeLines.find(line => line.endsWith('\tscripts/keep-exec.sh')) ?? '';
      assert.match(publishedClearedLine, /^100644 blob [0-9a-f]{40}\s+\d+\tscripts\/clear-exec\.sh$/, `expected 100644, got: ${publishedClearedLine}`);
      assert.match(publishedKeptLine, /^100755 blob [0-9a-f]{40}\s+\d+\tscripts\/keep-exec\.sh$/, `expected 100755, got: ${publishedKeptLine}`);
    } finally {
      await pubServer?.close();
      await githubApiServer?.close();
      await makeTreeWritableForCleanup(work).catch(() => undefined);
      await rm(work, { recursive: true, force: true });
    }
  });

  it('streams regular-file fd 0 into git -c core.bigFileThreshold=1m hash-object -w --stdin with constant O(1) child peak RSS on 8 MiB vs 96 MiB blobs', async () => {
    const execFileAsync = promisify(execFile);
    const rawWork = await mkdtemp(join(tmpdir(), 'lw-git-hash-rss-'));
    const work = await realpath(rawWork);
    const repo = join(work, 'repo');
    const pythonBin = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
    const gitBin = resolveGitExecutable();

    try {
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '--initial-branch=main']);

      const writePatternFile = async (filePath: string, sizeMiB: number, fillByte: number): Promise<string> => {
        const totalBytes = sizeMiB * 1024 * 1024;
        const chunk = Buffer.alloc(1024 * 1024, fillByte);
        const hasher = createHash('sha1').update(`blob ${totalBytes}\0`);
        const fh = await open(filePath, 'w', 0o600);
        try {
          for (let i = 0; i < sizeMiB; i += 1) {
            chunk.writeUInt32BE(i, 0);
            hasher.update(chunk);
            await fh.write(chunk, 0, chunk.byteLength, i * chunk.byteLength);
          }
        } finally {
          await fh.close();
        }
        return hasher.digest('hex');
      };

      const file8Path = join(work, 'blob-8m.bin');
      const file96Path = join(work, 'blob-96m.bin');
      const expected8Oid = await writePatternFile(file8Path, 8, 0x41);
      const expected96Oid = await writePatternFile(file96Path, 96, 0x42);

      const measureScript = `
import json, os, subprocess, sys
git_bin, repo_root, blob_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(blob_path, 'rb') as fh:
    proc = subprocess.Popen(
        [git_bin, '-c', 'core.hooksPath=/dev/null', '-c', 'core.bigFileThreshold=1m', '-C', repo_root, 'hash-object', '-w', '--stdin'],
        stdin=fh,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    out = proc.stdout.read().decode('utf-8').strip()
    err = proc.stderr.read().decode('utf-8').strip()
    proc.stdout.close()
    proc.stderr.close()
    _, status, rusage = os.wait4(proc.pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
    maxrss_bytes = int(rusage.ru_maxrss) if sys.platform == 'darwin' else int(rusage.ru_maxrss) * 1024
print(json.dumps({'exitCode': exit_code, 'oid': out, 'stderr': err, 'maxRssBytes': maxrss_bytes}))
`;

      const measure = async (blobPath: string): Promise<{ exitCode: number; oid: string; stderr: string; maxRssBytes: number }> => {
        const res = await execFileAsync(pythonBin, ['-c', measureScript, gitBin, repo, blobPath], {
          encoding: 'utf8',
          timeout: 120_000,
        });
        return JSON.parse(res.stdout.trim()) as { exitCode: number; oid: string; stderr: string; maxRssBytes: number };
      };

      const res8 = await measure(file8Path);
      assert.equal(res8.exitCode, 0, res8.stderr);
      assert.equal(res8.oid, expected8Oid);

      const res96 = await measure(file96Path);
      assert.equal(res96.exitCode, 0, res96.stderr);
      assert.equal(res96.oid, expected96Oid);

      // Regular-file fd 0 + core.bigFileThreshold=1m streams directly to a packfile instead of buffering 96 MiB in RAM.
      const rssBoundBytes = 48 * 1024 * 1024;
      assert.ok(
        res96.maxRssBytes < rssBoundBytes,
        `expected git hash-object peak RSS on 96 MiB regular-file fd 0 to stay < 48 MiB, got ${(res96.maxRssBytes / (1024 * 1024)).toFixed(1)} MiB (8 MiB was ${(res8.maxRssBytes / (1024 * 1024)).toFixed(1)} MiB)`,
      );
      assert.ok(
        Math.abs(res96.maxRssBytes - res8.maxRssBytes) < 32 * 1024 * 1024,
        `expected near-constant O(1) peak RSS between 8 MiB (${(res8.maxRssBytes / (1024 * 1024)).toFixed(1)} MiB) and 96 MiB (${(res96.maxRssBytes / (1024 * 1024)).toFixed(1)} MiB)`,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
