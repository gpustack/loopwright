import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inspectRun, signPayload } from '@loopwright/controller';
import {
  buildNativePullRequestBody,
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
      - pack
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
});
