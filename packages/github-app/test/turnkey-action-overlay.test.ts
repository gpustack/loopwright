import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { inspectRun, signPayload } from '@loopwright/controller';
import {
  discoverTaskpackUpstreams,
  GitHubAppError,
  isPrereleaseVersionTag,
  loadDeclarativeTaskpack,
  resolveRepositoryAndRevisions,
  runActionCli,
  runGitHubActionEntrypoint,
  startLocalCommandGateServer,
  startNativePullRequestPublisherServer,
} from '../src/index.js';
import {
  applyCarryDeltaToEffectiveBaseline,
  computeAllowedSourceRevisionCarryDelta,
  listBaselineRegularEntries,
  verifyBaseTreeAnchor,
} from '../src/turnkey.js';
import { compileDeclarativeTaskpack, DEFAULT_HOST_BUDGETS } from '../src/taskpack.js';
import { shouldPreserveExplicitSourceRevision } from '../src/upstreams.js';
import {
  GIT_TEST_ENV,
  git,
  gitWithInput,
  sseToolCall,
  sseStop,
  readJsonBody,
  startHttpServer,
} from './turnkey-action-fixtures.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';

const fastAdapter = createFastTurnkeyAdapter();

describe('tree_overlay command.v1 materialization and private GIT_INDEX_FILE publication (T4)', () => {
  async function postGateSigned(
    url: string,
    body: Record<string, unknown>,
    signingSecret: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-loopwright-signature': signPayload(signingSecret, raw),
      },
      body: raw,
    });
    return { status: response.status, json: JSON.parse(await response.text()) as Record<string, unknown> };
  }

  async function postPublisherSigned(
    url: string,
    body: Record<string, unknown>,
    signingSecret: string,
    authToken: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${authToken}`,
        'x-loopwright-signature': signPayload(signingSecret, raw),
      },
      body: raw,
    });
    return { status: response.status, json: JSON.parse(await response.text()) as Record<string, unknown> };
  }

  async function countFilesRecursive(dir: string): Promise<number> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countFilesRecursive(join(dir, entry.name));
      } else if (entry.isFile()) {
        count += 1;
      }
    }
    return count;
  }

  it('materializes baseline overlay tree including protected regular files, preserves 100755 bit, omits deleted dirs, and excludes protected symlinks in startLocalCommandGateServer', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-cmdgate-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let gateServer: Awaited<ReturnType<typeof startLocalCommandGateServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      const sharedCodex = join(work, 'shared-codex');
      await mkdir(sharedCodex, { recursive: true });
      await writeFile(join(sharedCodex, 'hooks.json'), '{"hooks":[]}\n');

      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.codex'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await mkdir(join(repo, 'docs', 'nested'), { recursive: true });
      await mkdir(join(repo, 'pack', 'items'), { recursive: true });

      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
      await writeFile(join(repo, '.codex', 'config.toml'), 'model = "gpt-5"\n');
      await symlink('../shared-codex/hooks.json', join(repo, '.codex', 'hooks.json'));
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Update docs and delete stale files.\n');
      await writeFile(join(repo, 'docs', 'untouched.txt'), 'baseline-untouched\n');
      await writeFile(join(repo, 'docs', 'overlay-edit.txt'), 'before-edit\n');
      await writeFile(join(repo, 'docs', 'overlay-delete.txt'), 'to-delete\n');
      await writeFile(join(repo, 'docs', 'nested', 'only-deleted.txt'), 'nested-delete\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');

      const execScriptPath = join(repo, 'scripts', 'check-exec.sh');
      await writeFile(execScriptPath, '#!/usr/bin/env bash\necho ok\n', { mode: 0o755 });
      await chmod(execScriptPath, 0o755);

      for (let i = 0; i < 135; i += 1) {
        const idx = String(i).padStart(3, '0');
        await writeFile(join(repo, 'pack', 'items', `item-${idx}.txt`), `item-${idx}\n`);
      }

      const gateScriptContent = `#!/usr/bin/env bash
set -euo pipefail
test "$(cat docs/untouched.txt)" = "baseline-untouched"
test "$(cat pack/items/item-134.txt)" = "item-134"
test -x scripts/check-exec.sh
test "$(cat docs/overlay-edit.txt)" = "after-overlay-edit"
test ! -e docs/overlay-delete.txt
test ! -e docs/nested/only-deleted.txt
test ! -d docs/nested
test "$(cat .github/workflows/ci.yml)" = "name: ci"
test "$(cat .codex/config.toml)" = 'model = "gpt-5"'
test ! -e .codex/hooks.json
`;
      const gateScriptRel = '.auto-sync/checks/verify.sh';
      await writeFile(join(repo, gateScriptRel), gateScriptContent, { mode: 0o755 });
      await chmod(join(repo, gateScriptRel), 0o755);
      const gateScriptSha256 = createHash('sha256').update(gateScriptContent).digest('hex');

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c2', 'write', {
            path: 'docs/overlay-edit.txt',
            content: 'after-overlay-edit\n',
          });
        } else if (step === 2) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c3', 'delete', {
            path: 'docs/overlay-delete.txt',
          });
        } else if (step === 3) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c4', 'delete', {
            path: 'docs/nested/only-deleted.txt',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 42 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: overlay-cmdgate
spec:
  goal:
    candidate: Overlay command gate check
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
      - 'scripts/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 15
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: overlay sync"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init 140+ files']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      const result = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 42,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-overlay-cmdgate',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-overlay-cmdgate-token-1234',
        },
      });

      assert.equal(result.kind, 'compiled', `unexpected result: ${JSON.stringify(result)}`);
      assert.equal(result.delegateOutcome?.ok, true, `overlay command.v1 gate failed: ${result.delegateOutcome?.detail}`);

      // Inspect the persisted run and verify manifest is tree_overlay, then hit startLocalCommandGateServer directly.
      const inspectOut = join(work, 'inspected-bundle');
      const inspected = await inspectRun({ runRoot, runId: 'run-overlay-cmdgate', output: inspectOut });
      assert.equal(inspected.ok, true);
      const candidateFilesDoc = JSON.parse(await readFile(join(inspectOut, 'candidate.files.json'), 'utf8')) as {
        manifest: {
          spec: {
            baseTree?: { commitOid: string; treeOid: string };
            entries: readonly { name: string }[];
            deleted?: readonly string[];
          };
        };
      };
      assert.equal(candidateFilesDoc.manifest.spec.baseTree?.commitOid, baseSha);
      assert.deepEqual(candidateFilesDoc.manifest.spec.deleted, ['docs/nested/only-deleted.txt', 'docs/overlay-delete.txt']);
      assert.deepEqual(
        candidateFilesDoc.manifest.spec.entries.map(e => e.name),
        ['docs/overlay-edit.txt', 'pack/proposal.json'],
      );
      const runResultDoc = JSON.parse(await readFile(join(inspectOut, 'result.json'), 'utf8')) as {
        spec: { subject: { candidateDigest: { hex: string } } };
      };

      gateServer = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: repo,
        gates: [{
          checkId: 'verify-cmd',
          gateId: 'verify-cmd',
          endpointRef: 'loopwright-local-command',
          script: gateScriptRel,
          scriptSha256: gateScriptSha256,
          timeoutSeconds: 15,
          allowReadOnlyGitHubToken: false,
          env: [],
        }],
      });
      const directVerdict = await postGateSigned(
        gateServer.url,
        {
          storeId: 'store',
          runId: 'run-overlay-cmdgate',
          lockHash: null,
          operationId: 'op-direct',
          dispatchId: 'disp-direct',
          dispatchGeneration: 1,
          gateId: 'verify-cmd',
          checkId: 'verify-cmd',
          candidateDigest: runResultDoc.spec.subject.candidateDigest.hex,
        },
        gateServer.signingSecret,
      );
      assert.equal(directVerdict.status, 200);
      assert.equal(directVerdict.json['status'], 'approved', `direct gate denied: ${JSON.stringify(directVerdict.json)}`);
    } finally {
      await gateServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('executes 600+-file tree_overlay turnkey initial PR + revise PR with .claude/.codex symlinks, .gitattributes filters, 100755 modes, delete, zero untouched CAS copies, and zero .git/worktrees mutations', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-e2e-600-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      const sharedSkills = join(work, 'shared-skills');
      const sharedCodex = join(work, 'shared-codex');
      await mkdir(sharedSkills, { recursive: true });
      await mkdir(sharedCodex, { recursive: true });
      await writeFile(join(sharedSkills, 'guide.md'), '# Skill\n');
      await writeFile(join(sharedCodex, 'hooks.json'), '{"hooks":[]}\n');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);

      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.claude'), { recursive: true });
      await mkdir(join(repo, '.codex'), { recursive: true });
      await symlink('../shared-skills', join(repo, '.claude', 'skills'));
      await symlink('../shared-codex/hooks.json', join(repo, '.codex', 'hooks.json'));

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'fixtures'), { recursive: true });
      await mkdir(join(repo, 'pack', 'items'), { recursive: true });

      await writeFile(join(repo, '.gitattributes'), '*.crlf eol=crlf\n*.ident ident\n*.trap filter=trap\n');
      await writeFile(join(repo, 'fixtures', 'raw.crlf'), 'line1\nline2\n');
      await writeFile(join(repo, 'fixtures', 'raw.ident'), '$Id$\n');
      await writeFile(join(repo, 'fixtures', 'raw.trap'), 'raw-trap-bytes\n');

      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Sync pack and docs.\n');
      await writeFile(join(repo, 'docs', 'untouched.txt'), 'keep-me-untouched\n');
      await writeFile(join(repo, 'docs', 'to-edit.txt'), 'before-edit\n');
      await writeFile(join(repo, 'docs', 'to-delete.txt'), 'delete-me\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');

      const buildStepPath = join(repo, 'scripts', 'build-step.sh');
      await writeFile(buildStepPath, '#!/usr/bin/env bash\necho before\n', { mode: 0o755 });
      await chmod(buildStepPath, 0o755);

      const untouchedExecPath = join(repo, 'scripts', 'untouched-exec.sh');
      await writeFile(untouchedExecPath, '#!/usr/bin/env bash\necho untouched\n', { mode: 0o755 });
      await chmod(untouchedExecPath, 0o755);

      await Promise.all(
        Array.from({ length: 265 }, (_, i) => {
          const idx = String(i).padStart(3, '0');
          return writeFile(join(repo, 'pack', 'items', `file-${idx}.txt`), `payload-${idx}\n`);
        }),
      );

      const verifyScript = `#!/usr/bin/env bash
set -euo pipefail
test "$(cat docs/untouched.txt)" = "keep-me-untouched"
test "$(cat pack/items/file-264.txt)" = "payload-264"
test -x scripts/build-step.sh
test -x scripts/untouched-exec.sh
test ! -e docs/to-delete.txt
test ! -e .claude/skills
test ! -e .codex/hooks.json
printf 'line1\nline2\n' | cmp -s - fixtures/raw.crlf
printf '$Id$\n' | cmp -s - fixtures/raw.ident
printf 'raw-trap-bytes\n' | cmp -s - fixtures/raw.trap
`;
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), verifyScript, { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      let phase: 'initial' | 'revise' = 'initial';
      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        let sseBody: string;
        if (phase === 'initial') {
          if (step === 0) {
            sseBody = sseToolCall('gpt-4.1-mini', 'p1-1', 'write', {
              path: 'pack/proposal.json',
              content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
            });
          } else if (step === 1) {
            sseBody = sseToolCall('gpt-4.1-mini', 'p1-2', 'write', {
              path: 'docs/to-edit.txt',
              content: 'edited-v1\n',
            });
          } else if (step === 2) {
            sseBody = sseToolCall('gpt-4.1-mini', 'p1-3', 'write', {
              path: 'scripts/build-step.sh',
              content: '#!/usr/bin/env bash\necho edited-v1\n',
            });
          } else if (step === 3) {
            sseBody = sseToolCall('gpt-4.1-mini', 'p1-4', 'delete', {
              path: 'docs/to-delete.txt',
            });
          } else {
            sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
          }
        } else {
          if (step === 0) {
            sseBody = sseToolCall('gpt-4.1-mini', 'p2-1', 'write', {
              path: 'docs/to-edit.txt',
              content: 'edited-v2\n',
            });
          } else if (step === 1) {
            sseBody = sseToolCall('gpt-4.1-mini', 'p2-2', 'write', {
              path: 'docs/revise-note.txt',
              content: 'revise-v2\n',
            });
          } else {
            sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
          }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: overlay-600
spec:
  goal:
    candidate: Update synced files on 600+ file repo
    noChange: Verify no change
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
      - 'scripts/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 20
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: overlay 600 sync"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
    commentPrefixes:
      - /loopwright
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiServer.url}/v1
      cost:
        input: 1
        output: 2
  output:
    formats: [json]
`);

      // Write raw blobs for .gitattributes fixtures and configure filter.trap to fail if any working-tree smudge/clean runs.
      await git(repo, ['add', '.']);
      await git(repo, ['config', 'filter.trap.smudge', 'false']);
      await git(repo, ['config', 'filter.trap.clean', 'false']);
      await git(repo, ['commit', '-m', 'init 600+ file repo']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);
      const baseTreeEntries = await git(repo, ['ls-tree', '-r', '--full-tree', baseSha]);
      const oidOf = (treeOut: string, targetPath: string): { mode: string; oid: string } | undefined => {
        for (const line of treeOut.split('\n')) {
          const m = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(line);
          if (m && m[3] === targetPath) return { mode: m[1]!, oid: m[2]! };
        }
        return undefined;
      };
      const crlfBase = oidOf(baseTreeEntries, 'fixtures/raw.crlf');
      const identBase = oidOf(baseTreeEntries, 'fixtures/raw.ident');
      const trapBase = oidOf(baseTreeEntries, 'fixtures/raw.trap');
      const file264Base = oidOf(baseTreeEntries, 'pack/items/file-264.txt');
      const untouchedBase = oidOf(baseTreeEntries, 'docs/untouched.txt');
      assert.ok(crlfBase && identBase && trapBase && file264Base && untouchedBase);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      let openPrHeadSha = '';
      let prPosts = 0;
      let prPatches = 0;
      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 901 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          if (openPrHeadSha.length === 0) {
            res.end(JSON.stringify([]));
          } else {
            res.end(JSON.stringify([{
              number: 42,
              html_url: 'https://github.invalid/acme/repo/pull/42',
              title: 'chore: overlay 600 sync',
              body: 'PR body',
              state: 'open',
              base: { ref: 'main', sha: baseSha },
              head: { ref: 'loopwright/main', sha: openPrHeadSha, repo: { full_name: 'acme/repo', fork: false } },
            }]));
          }
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/42' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 42,
            base: { ref: 'main', sha: baseSha },
            head: { ref: 'loopwright/main', sha: openPrHeadSha },
          }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          if (headRef.startsWith('loopwright/memory/')) {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 43,
              html_url: 'https://github.invalid/acme/repo/pull/43',
              head: { ref: headRef, sha: '0'.repeat(40) },
              base: { ref: 'main', sha: baseSha },
            }));
            return;
          }
          prPosts += 1;
          const remoteLs = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main']);
          openPrHeadSha = remoteLs.split(/\s+/)[0]!;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 42,
            html_url: 'https://github.invalid/acme/repo/pull/42',
            head: { ref: 'loopwright/main', sha: openPrHeadSha },
            base: { ref: 'main', sha: baseSha },
          }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/42' && req.method === 'PATCH') {
          prPatches += 1;
          await readJsonBody(req);
          const remoteLs = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main']);
          openPrHeadSha = remoteLs.split(/\s+/)[0]!;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 42,
            html_url: 'https://github.invalid/acme/repo/pull/42',
            head: { ref: 'loopwright/main', sha: openPrHeadSha },
            base: { ref: 'main', sha: baseSha },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const initResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 901,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-overlay-600-init',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_600_secret_token_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-overlay-600-init-token-1234',
        },
      });
      assert.equal(initResult.kind, 'compiled', `unexpected initResult: ${JSON.stringify(initResult)}`);
      assert.equal(initResult.delegateOutcome?.ok, true, `init run failed: ${initResult.delegateOutcome?.detail}`);
      assert.equal(prPosts, 1);

      // Zero .git/worktrees mutations and untouched checkout.
      assert.equal(existsSync(join(repo, '.git', 'worktrees')), false, '.git/worktrees must never be created');
      assert.equal(await git(repo, ['rev-parse', 'HEAD']), baseSha);
      assert.equal(await git(repo, ['status', '--porcelain']), '');

      // Verify zero untouched CAS copies (only modified overlay blobs + run metadata/checkpoints stored, never 600+ untouched baseline files).
      const casBlobCount = await countFilesRecursive(join(runRoot, 'run-overlay-600-init', 'artifacts'));
      assert.ok(casBlobCount <= 100, `expected zero untouched CAS copies (<= 100 metadata/overlay artifacts), found ${casBlobCount} files in CAS artifacts`);
      const inspectInitOut = join(work, 'inspect-init');
      const inspectedInit = await inspectRun({ runRoot, runId: 'run-overlay-600-init', output: inspectInitOut });
      assert.equal(inspectedInit.ok, true);
      const initCandidateDoc = JSON.parse(await readFile(join(inspectInitOut, 'candidate.files.json'), 'utf8')) as {
        manifest: { spec: { entries: readonly { name: string }[]; deleted?: readonly string[] } };
      };
      assert.deepEqual(
        initCandidateDoc.manifest.spec.entries.map(e => e.name),
        ['docs/to-edit.txt', 'pack/proposal.json', 'scripts/build-step.sh'],
      );
      assert.deepEqual(initCandidateDoc.manifest.spec.deleted, ['docs/to-delete.txt']);

      // Verify initial published PR tree on bareRemote.
      const prHeadSha1 = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).split(/\s+/)[0]!;
      assert.match(prHeadSha1, /^[0-9a-f]{40}$/);
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);
      const pr1Msg = await git(repo, ['log', '-1', '--format=%B', prHeadSha1]);
      assert.match(
        pr1Msg,
        /Signed-off-by: github-actions\[bot\] <41898282\+github-actions\[bot\]@users\.noreply\.github\.com>/,
      );
      const pr1Tree = await git(repo, ['ls-tree', '-r', '--full-tree', prHeadSha1]);
      assert.deepEqual(oidOf(pr1Tree, 'pack/items/file-264.txt'), file264Base);
      assert.deepEqual(oidOf(pr1Tree, 'docs/untouched.txt'), untouchedBase);
      assert.deepEqual(oidOf(pr1Tree, 'fixtures/raw.crlf'), crlfBase);
      assert.deepEqual(oidOf(pr1Tree, 'fixtures/raw.ident'), identBase);
      assert.deepEqual(oidOf(pr1Tree, 'fixtures/raw.trap'), trapBase);
      assert.equal(oidOf(pr1Tree, 'docs/to-delete.txt'), undefined, 'deleted path must be absent from PR commit');
      assert.equal(oidOf(pr1Tree, 'scripts/build-step.sh')?.mode, '100755', 'modified script must keep 100755 mode');
      assert.equal(oidOf(pr1Tree, 'scripts/untouched-exec.sh')?.mode, '100755');
      assert.equal(oidOf(pr1Tree, '.claude/skills')?.mode, '120000');
      assert.equal(oidOf(pr1Tree, '.codex/hooks.json')?.mode, '120000');
      assert.equal(await git(repo, ['cat-file', 'blob', `${prHeadSha1}:docs/to-edit.txt`]), 'edited-v1');
      assert.equal(await git(repo, ['cat-file', 'blob', `${prHeadSha1}:scripts/build-step.sh`]), '#!/usr/bin/env bash\necho edited-v1');

      // Phase 2: revise run on the open managed PR.
      phase = 'revise';
      turn = 0;
      const reviseResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 901,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 42, pull_request: {} },
          comment: {
            id: 7001,
            body: '/loopwright revise Add docs/revise-note.txt and update docs/to-edit.txt',
            author_association: 'OWNER',
            user: { login: 'maintainer' },
          },
        },
        runRoot,
        runId: 'run-overlay-600-revise',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_600_secret_token_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-overlay-600-revise-token-1234',
        },
      });
      assert.equal(reviseResult.kind, 'compiled', `unexpected reviseResult: ${JSON.stringify(reviseResult)}`);
      assert.equal(reviseResult.delegateOutcome?.ok, true, `revise run failed: ${reviseResult.delegateOutcome?.detail}`);
      assert.equal(prPosts, 1);
      assert.equal(prPatches, 1);
      assert.equal(existsSync(join(repo, '.git', 'worktrees')), false, '.git/worktrees must never be created on revise');

      const prHeadSha2 = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).split(/\s+/)[0]!;
      assert.notEqual(prHeadSha2, prHeadSha1);
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);
      const pr2Tree = await git(repo, ['ls-tree', '-r', '--full-tree', prHeadSha2]);
      assert.deepEqual(oidOf(pr2Tree, 'pack/items/file-264.txt'), file264Base);
      assert.deepEqual(oidOf(pr2Tree, 'docs/untouched.txt'), untouchedBase);
      assert.equal(oidOf(pr2Tree, 'docs/to-delete.txt'), undefined, 'Phase 1 deletion must stay deleted after revise');
      assert.equal(oidOf(pr2Tree, 'scripts/build-step.sh')?.mode, '100755');
      assert.equal(await git(repo, ['cat-file', 'blob', `${prHeadSha2}:scripts/build-step.sh`]), '#!/usr/bin/env bash\necho edited-v1');
      assert.equal(await git(repo, ['cat-file', 'blob', `${prHeadSha2}:docs/to-edit.txt`]), 'edited-v2');
      assert.equal(await git(repo, ['cat-file', 'blob', `${prHeadSha2}:docs/revise-note.txt`]), 'revise-v2');
      assert.equal(oidOf(pr2Tree, '.claude/skills')?.mode, '120000');
      assert.equal(oidOf(pr2Tree, '.codex/hooks.json')?.mode, '120000');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a writable tracked symlink during native PR index-plumbing publication', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-sym-pub-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, 'outside.txt'), 'secret-outside\n');
      await symlink('../outside.txt', join(repo, 'docs', 'sym-target.txt'));
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Attempt symlink overwrite.\n');

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 's1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 's2', 'write', {
            path: 'docs/sym-target.txt',
            content: 'overwritten-regular-file\n',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      let baseSha = '';
      let prHeadSha = '';
      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 77 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{
            number: 19,
            html_url: 'https://github.invalid/acme/repo/pull/19',
            title: 'chore: sym test',
            body: 'PR body',
            state: 'open',
            base: { ref: 'main', sha: baseSha },
            head: { ref: 'loopwright/main', sha: prHeadSha, repo: { full_name: 'acme/repo', fork: false } },
          }]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/19' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 19,
            base: { ref: 'main', sha: baseSha },
            head: { ref: 'loopwright/main', sha: prHeadSha },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: sym-pub-check
spec:
  goal:
    candidate: Symlink publication refusal
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: sym test"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - revise
    commentPrefixes:
      - /loopwright
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiServer.url}/v1
      cost:
        input: 1
        output: 2
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init symlink on main']);
      baseSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', '-b', 'loopwright/main']);
      await git(repo, ['rm', 'docs/sym-target.txt']);
      await git(repo, ['commit', '-m', 'remove symlink on PR branch before revise']);
      prHeadSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', 'main']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main', 'loopwright/main']);

      const runResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 77,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 19, pull_request: {} },
          comment: {
            id: 7009,
            body: '/loopwright revise Recreate docs/sym-target.txt',
            author_association: 'OWNER',
            user: { login: 'maintainer' },
          },
        },
        runRoot,
        runId: 'run-sym-pub-check',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_sym_pub_secret_token_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-sym-pub-check-token-1234',
        },
      });
      assert.equal(runResult.kind, 'compiled', `unexpected runResult: ${JSON.stringify(runResult)}`);
      assert.equal(runResult.delegateOutcome?.ok, false);

      const inspectOut = join(work, 'inspect-sym');
      const inspected = await inspectRun({ runRoot, runId: 'run-sym-pub-check', output: inspectOut });
      assert.equal(inspected.ok, true);
      const publicationDoc = JSON.parse(await readFile(join(inspectOut, 'publication.json'), 'utf8')) as {
        status: string;
        receipt: { outcome: string };
      };
      assert.equal(publicationDoc.receipt.outcome, 'not_executed');
      const runResultDoc = JSON.parse(await readFile(join(inspectOut, 'result.json'), 'utf8')) as {
        spec: { subject: { candidateDigest: { hex: string } } };
      };

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        remoteUrl: bareRemote,
        apiBaseUrl: githubServer.url,
        gitWriteToken: 'ghp_sym_pub_secret_token_1234',
      });

      const pubPayloadRaw = Buffer.from(JSON.stringify({
        storeId: 'store',
        runId: 'run-sym-pub-check',
        lockHash: null,
        operationId: 'op-sym-1',
        dispatchId: 'disp-sym-1',
        dispatchGeneration: 1,
        idempotencyKey: 'idem-sym-1',
        candidateDigest: runResultDoc.spec.subject.candidateDigest.hex,
      }), 'utf8');
      const pubResponse = await fetch(pubServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${pubServer.authToken}`,
          'x-loopwright-signature': signPayload(pubServer.signingSecret, pubPayloadRaw),
        },
        body: pubPayloadRaw,
      });
      assert.equal(pubResponse.status, 200);
      const receipt = JSON.parse(await pubResponse.text()) as { outcome: string; reason: string | null };
      assert.equal(receipt.outcome, 'not_executed');
      assert.match(receipt.reason ?? '', /Refusing to overwrite symlinked candidate path during native PR publication\./);
      assert.equal(existsSync(join(repo, '.git', 'worktrees')), false);
    } finally {
      await pubServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('listBaselineRegularEntries enforces protected-only 120000/160000 specials, .git/oversized path guards, and >65,536 entry cap', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-baseline-list-')));
    try {
      const repo = join(work, 'repo');
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.codex'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await writeFile(join(repo, 'AGENTS.md'), '# Agents\n');
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci\n');
      await writeFile(join(repo, 'docs', 'readme.txt'), 'ok\n');
      await symlink('../outside.json', join(repo, '.codex', 'hooks.json'));
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'protected regular + protected symlink']);
      const protectedOnlySha = await git(repo, ['rev-parse', 'HEAD']);

      const protectedEntries = await listBaselineRegularEntries(repo, protectedOnlySha);
      assert.deepEqual(
        protectedEntries.map(e => e.path).sort(),
        ['.github/workflows/ci.yml', 'AGENTS.md', 'docs/readme.txt'],
      );

      // Unprotected 120000 symlink must be rejected.
      await symlink('../outside.json', join(repo, 'docs', 'bad-link.txt'));
      await git(repo, ['add', 'docs/bad-link.txt']);
      await git(repo, ['commit', '-m', 'unprotected symlink']);
      const badSymSha = await git(repo, ['rev-parse', 'HEAD']);
      await assert.rejects(
        () => listBaselineRegularEntries(repo, badSymSha),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID' && /unprotected symlink/.test(err.message),
      );

      // Unprotected 160000 gitlink must be rejected.
      const subOid = await git(repo, ['rev-parse', 'HEAD']);
      const emptyBlob = await gitWithInput(repo, ['hash-object', '-w', '--stdin'], '');
      const gitlinkTree = await gitWithInput(
        repo,
        ['mktree'],
        `100644 blob ${emptyBlob}\tREADME.md\n160000 commit ${subOid}\tvendor-sub\n`,
      );
      const gitlinkCommit = await gitWithInput(repo, ['commit-tree', gitlinkTree], 'gitlink\n');
      await assert.rejects(
        () => listBaselineRegularEntries(repo, gitlinkCommit),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID' && /unprotected gitlink/.test(err.message),
      );

      // .git path segment must be rejected.
      const innerGitTree = await gitWithInput(repo, ['mktree'], `100644 blob ${emptyBlob}\tconfig\n`);
      const outerGitTree = await gitWithInput(repo, ['mktree'], `040000 tree ${innerGitTree}\t.git\n`);
      const dotGitCommit = await gitWithInput(repo, ['commit-tree', outerGitTree], 'dotgit\n');
      await assert.rejects(
        () => listBaselineRegularEntries(repo, dotGitCommit),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID' && /invalid baseline path segment/.test(err.message),
      );

      // >255-byte path segment must be rejected.
      const longSegTree = await gitWithInput(repo, ['mktree'], `100644 blob ${emptyBlob}\t${'a'.repeat(256)}\n`);
      const longSegCommit = await gitWithInput(repo, ['commit-tree', longSegTree], 'longseg\n');
      await assert.rejects(
        () => listBaselineRegularEntries(repo, longSegCommit),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID' && /invalid baseline path segment/.test(err.message),
      );

      // >65,536 regular entries must be rejected.
      const idxRepo = join(work, 'idx-repo');
      await mkdir(idxRepo, { recursive: true });
      await git(idxRepo, ['init', '-b', 'main']);
      const idxBlob = await gitWithInput(idxRepo, ['hash-object', '-w', '--stdin'], '');
      const indexLines: string[] = [];
      for (let i = 0; i < 65_537; i += 1) {
        const dir = `d${String(Math.floor(i / 1000)).padStart(2, '0')}`;
        indexLines.push(`100644 blob ${idxBlob}\t${dir}/f${i}.txt\0`);
      }
      await gitWithInput(idxRepo, ['update-index', '-z', '--index-info'], indexLines.join(''));
      const hugeTree = await git(idxRepo, ['write-tree']);
      const hugeCommit = await gitWithInput(idxRepo, ['commit-tree', hugeTree], 'huge\n');
      await assert.rejects(
        () => listBaselineRegularEntries(idxRepo, hugeCommit),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID' && /65536/.test(err.message),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('refuses baseTree.treeOid and baseTree.commitOid mismatches in startLocalCommandGateServer and startNativePullRequestPublisherServer', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-basetree-bind-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let gateServer: Awaited<ReturnType<typeof startLocalCommandGateServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack', 'items'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Update docs.\n');
      await writeFile(join(repo, 'docs', 'note.txt'), 'v1\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      for (let i = 0; i < 135; i += 1) {
        await writeFile(join(repo, 'pack', 'items', `item-${String(i).padStart(3, '0')}.txt`), `item-${i}\n`);
      }
      const gateScriptContent = '#!/usr/bin/env bash\nexit 0\n';
      const gateScriptRel = '.auto-sync/checks/verify.sh';
      await writeFile(join(repo, gateScriptRel), gateScriptContent, { mode: 0o755 });
      await chmod(join(repo, gateScriptRel), 0o755);
      const gateScriptSha256 = createHash('sha256').update(gateScriptContent).digest('hex');

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        const sseBody = step === 0
          ? sseToolCall('gpt-4.1-mini', 'b1', 'write', {
              path: 'pack/proposal.json',
              content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
            })
          : sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 88 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: basetree-bind
spec:
  goal:
    candidate: Verify baseTree binding
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 10
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: bind check"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base commit']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      const result = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 88,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-basetree-bind',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-basetree-bind-token-1234',
        },
      });
      assert.equal(result.kind, 'compiled', `unexpected result: ${JSON.stringify(result)}`);
      assert.equal(result.delegateOutcome?.ok, true);

      const inspectOut = join(work, 'inspect-bind');
      const inspected = await inspectRun({ runRoot, runId: 'run-basetree-bind', output: inspectOut });
      assert.equal(inspected.ok, true);
      const runResultDoc = JSON.parse(await readFile(join(inspectOut, 'result.json'), 'utf8')) as {
        spec: { subject: { candidateDigest: { hex: string } } };
      };
      const candidateDigest = runResultDoc.spec.subject.candidateDigest.hex;

      // Create a second commit and a tamperedRepo where baseSha^{tree} resolves to otherSha's tree.
      await writeFile(join(repo, 'docs', 'note.txt'), 'v2\n');
      await git(repo, ['add', 'docs/note.txt']);
      await git(repo, ['commit', '-m', 'other commit']);
      const otherSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', baseSha]);

      const tamperedRepo = join(work, 'tampered-repo');
      await cp(repo, tamperedRepo, { recursive: true });
      await git(tamperedRepo, ['replace', baseSha, otherSha]);

      gateServer = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: tamperedRepo,
        gates: [{
          checkId: 'verify-cmd',
          gateId: 'verify-cmd',
          endpointRef: 'loopwright-local-command',
          script: gateScriptRel,
          scriptSha256: gateScriptSha256,
          timeoutSeconds: 10,
          allowReadOnlyGitHubToken: false,
          env: [],
        }],
      });
      const gateVerdict = await postGateSigned(
        gateServer.url,
        {
          storeId: 'store',
          runId: 'run-basetree-bind',
          lockHash: null,
          operationId: 'op-bt-gate',
          dispatchId: 'disp-bt-gate',
          dispatchGeneration: 1,
          gateId: 'verify-cmd',
          checkId: 'verify-cmd',
          candidateDigest,
        },
        gateServer.signingSecret,
      );
      assert.equal(gateVerdict.status, 200);
      assert.equal(gateVerdict.json['status'], 'denied');
      assert.match(String(gateVerdict.json['reason'] ?? ''), /baseTree\.treeOid .* does not match/);
      await gateServer.close();
      gateServer = undefined;

      // Also verify verifyBaseTreeAnchor refuses commitOid !== expectedCommitOid (snapshot.sourceRevision check in gate server)
      const baseTreeOid = await git(repo, ['rev-parse', `${baseSha}^{tree}`]);
      await assert.rejects(
        () => verifyBaseTreeAnchor(
          repo,
          { objectFormat: 'sha1', commitOid: baseSha, treeOid: baseTreeOid },
          GIT_TEST_ENV as Record<string, string>,
          otherSha,
        ),
        (err: unknown) => err instanceof GitHubAppError
          && err.code === 'ACTION_INPUT_INVALID'
          && /does not match sourceRevision/.test(err.message),
      );

      // Gate server also refuses streamed git cat-file --batch blob OID mismatch (same byteLength, different content via git replace).
      const noteV1Oid = await git(repo, ['rev-parse', `${baseSha}:docs/note.txt`]);
      const noteV2Oid = await git(repo, ['rev-parse', `${otherSha}:docs/note.txt`]);
      const blobTamperedRepo = join(work, 'blob-tampered-repo');
      await cp(repo, blobTamperedRepo, { recursive: true });
      await git(blobTamperedRepo, ['replace', noteV1Oid, noteV2Oid]);

      gateServer = await startLocalCommandGateServer({
        runRoot,
        repositoryRoot: blobTamperedRepo,
        gates: [{
          checkId: 'verify-cmd',
          gateId: 'verify-cmd',
          endpointRef: 'loopwright-local-command',
          script: gateScriptRel,
          scriptSha256: gateScriptSha256,
          timeoutSeconds: 10,
          allowReadOnlyGitHubToken: false,
          env: [],
        }],
      });
      const blobMismatchVerdict = await postGateSigned(
        gateServer.url,
        {
          storeId: 'store',
          runId: 'run-basetree-bind',
          lockHash: null,
          operationId: 'op-bt-gate-blob',
          dispatchId: 'disp-bt-gate-blob',
          dispatchGeneration: 1,
          gateId: 'verify-cmd',
          checkId: 'verify-cmd',
          candidateDigest,
        },
        gateServer.signingSecret,
      );
      assert.equal(blobMismatchVerdict.status, 200);
      assert.equal(blobMismatchVerdict.json['status'], 'denied');
      assert.match(String(blobMismatchVerdict.json['reason'] ?? ''), /baseline blob digest mismatch for "docs\/note\.txt"/);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);

      // 1) Publisher refuses baseTree.commitOid !== sourceRevision (signed request overrides sourceRevision).
      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        remoteUrl: bareRemote,
      });
      const commitMismatchRes = await postPublisherSigned(
        pubServer.url,
        {
          storeId: 'store',
          runId: 'run-basetree-bind',
          lockHash: null,
          operationId: 'op-bt-pub-1',
          dispatchId: 'disp-bt-pub-1',
          dispatchGeneration: 1,
          idempotencyKey: 'idem-bt-1',
          candidateDigest,
          baseRevision: baseSha,
          sourceRevision: otherSha,
        },
        pubServer.signingSecret,
        pubServer.authToken,
      );
      assert.equal(commitMismatchRes.status, 200);
      assert.equal(commitMismatchRes.json['outcome'], 'not_executed');
      assert.match(String(commitMismatchRes.json['reason'] ?? ''), /does not match sourceRevision/);
      await pubServer.close();
      pubServer = undefined;

      // 2) Publisher refuses baseTree.treeOid mismatch.
      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: tamperedRepo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        remoteUrl: bareRemote,
      });
      const treeMismatchRes = await postPublisherSigned(
        pubServer.url,
        {
          storeId: 'store',
          runId: 'run-basetree-bind',
          lockHash: null,
          operationId: 'op-bt-pub-2',
          dispatchId: 'disp-bt-pub-2',
          dispatchGeneration: 1,
          idempotencyKey: 'idem-bt-2',
          candidateDigest,
        },
        pubServer.signingSecret,
        pubServer.authToken,
      );
      assert.equal(treeMismatchRes.status, 200);
      assert.equal(treeMismatchRes.json['outcome'], 'not_executed');
      assert.match(String(treeMismatchRes.json['reason'] ?? ''), /baseTree\.treeOid .* does not match/);
      assert.equal(await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main']), '');
    } finally {
      await gateServer?.close();
      await pubServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('keeps baseRevision protected files and honors sourceRevision 100755->100644 mode change during revise, and refuses 160000 gitlink overwrite', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-revise-prot-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'scripts'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack', 'items'), { recursive: true });

      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci-base\n');
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Update scripts and proposal.\n');
      await writeFile(join(repo, 'docs', 'keep.txt'), 'base-keep\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      const runScript = join(repo, 'scripts', 'run.sh');
      await writeFile(runScript, '#!/usr/bin/env bash\necho v1\n', { mode: 0o755 });
      await chmod(runScript, 0o755);
      for (let i = 0; i < 135; i += 1) {
        await writeFile(join(repo, 'pack', 'items', `item-${String(i).padStart(3, '0')}.txt`), `item-${i}\n`);
      }

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'r1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'r2', 'write', {
            path: 'scripts/run.sh',
            content: '#!/usr/bin/env bash\necho revised\n',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      let baseSha = '';
      let prHeadSha = '';
      let prPatches = 0;
      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 92 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{
            number: 55,
            html_url: 'https://github.invalid/acme/repo/pull/55',
            title: 'chore: revise prot',
            body: 'PR body',
            state: 'open',
            base: { ref: 'main', sha: baseSha },
            head: { ref: 'loopwright/main', sha: prHeadSha, repo: { full_name: 'acme/repo', fork: false } },
          }]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/55' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 55,
            base: { ref: 'main', sha: baseSha },
            head: { ref: 'loopwright/main', sha: prHeadSha },
          }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/55' && req.method === 'PATCH') {
          prPatches += 1;
          await readJsonBody(req);
          const remoteLs = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main']);
          prHeadSha = remoteLs.split(/\s+/)[0]!;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 55,
            html_url: 'https://github.invalid/acme/repo/pull/55',
            head: { ref: 'loopwright/main', sha: prHeadSha },
            base: { ref: 'main', sha: baseSha },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: revise-prot-mode
spec:
  goal:
    candidate: Revise protected content and mode check
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
      - 'scripts/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: revise prot"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - revise
    commentPrefixes:
      - /loopwright
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiServer.url}/v1
      cost:
        input: 1
        output: 2
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init main']);
      baseSha = await git(repo, ['rev-parse', 'HEAD']);

      // Open PR branch modifies protected .github/workflows/ci.yml, flips scripts/run.sh 100755 -> 100644, and adds docs/pr-only.txt.
      await git(repo, ['checkout', '-b', 'loopwright/main']);
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: ci-pr-tampered\n');
      await chmod(runScript, 0o644);
      await writeFile(join(repo, 'docs', 'pr-only.txt'), 'from-pr\n');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'pr branch changes protected file and drops exec mode']);
      prHeadSha = await git(repo, ['rev-parse', 'HEAD']);
      const initialPrHeadSha = prHeadSha;
      await git(repo, ['checkout', 'main']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main', 'loopwright/main']);

      const reviseRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 92,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 55, pull_request: {} },
          comment: {
            id: 8001,
            body: '/loopwright revise Update scripts/run.sh',
            author_association: 'OWNER',
            user: { login: 'maintainer' },
          },
        },
        runRoot,
        runId: 'run-revise-prot-mode',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_revise_prot_secret_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-revise-prot-token-1234',
        },
      });
      assert.equal(reviseRes.kind, 'compiled', `unexpected reviseRes: ${JSON.stringify(reviseRes)}`);
      assert.equal(reviseRes.delegateOutcome?.ok, true, `revise failed: ${reviseRes.delegateOutcome?.detail}`);
      assert.equal(prPatches, 1);

      const publishedSha = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).split(/\s+/)[0]!;
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);
      const publishedTree = await git(repo, ['ls-tree', '-r', '--full-tree', publishedSha]);
      const modeOf = (treeOut: string, targetPath: string): string | undefined => {
        for (const line of treeOut.split('\n')) {
          const m = /^(\d{6}) (?:blob|commit) [0-9a-f]{40}\t(.+)$/.exec(line);
          if (m && m[2] === targetPath) return m[1];
        }
        return undefined;
      };
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${publishedSha}:.github/workflows/ci.yml`]),
        'name: ci-base',
        'baseRevision protected content must win over PR branch protected modification',
      );
      assert.equal(
        modeOf(publishedTree, 'scripts/run.sh'),
        '100644',
        'sourceRevision 100644 mode must take precedence over baseRevision 100755 mode',
      );
      assert.equal(await git(repo, ['cat-file', 'blob', `${publishedSha}:docs/pr-only.txt`]), 'from-pr');

      // Also verify hasSymlinkAtOrAbove refuses a 160000 gitlink entry in baseRevision when PR branch replaced it with a regular file.
      const inspectOut = join(work, 'inspect-gitlink');
      const inspected = await inspectRun({ runRoot, runId: 'run-revise-prot-mode', output: inspectOut });
      assert.equal(inspected.ok, true);
      const runResultDoc = JSON.parse(await readFile(join(inspectOut, 'result.json'), 'utf8')) as {
        spec: { subject: { candidateDigest: { hex: string } } };
      };
      const gitlinkBaseTree = await gitWithInput(
        repo,
        ['mktree'],
        `160000 commit ${baseSha}\tscripts\n`,
      );
      const gitlinkBaseCommit = await gitWithInput(repo, ['commit-tree', gitlinkBaseTree], 'gitlink base\n');

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'loopwright/',
        remoteUrl: bareRemote,
      });
      const gitlinkRefusal = await postPublisherSigned(
        pubServer.url,
        {
          storeId: 'store',
          runId: 'run-revise-prot-mode',
          lockHash: null,
          operationId: 'op-gitlink-1',
          dispatchId: 'disp-gitlink-1',
          dispatchGeneration: 1,
          idempotencyKey: 'idem-gitlink-1',
          candidateDigest: runResultDoc.spec.subject.candidateDigest.hex,
          baseRevision: gitlinkBaseCommit,
          sourceRevision: initialPrHeadSha,
        },
        pubServer.signingSecret,
        pubServer.authToken,
      );
      assert.equal(gitlinkRefusal.status, 200);
      assert.equal(gitlinkRefusal.json['outcome'], 'not_executed');
      assert.match(
        String(gitlinkRefusal.json['reason'] ?? ''),
        /Refusing to overwrite symlinked candidate path during native PR publication\./,
      );
    } finally {
      await pubServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('deletes omitted writable files in classic-mode native PR publication under GIT_INDEX_FILE plumbing', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-t4-classic-del-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'docs'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });

      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: classic-ci\n');
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Delete docs/obsolete.txt and update proposal.\n');
      await writeFile(join(repo, 'docs', 'keep.txt'), 'keep\n');
      await writeFile(join(repo, 'docs', 'obsolete.txt'), 'delete-me\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'cd1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'cd2', 'delete', {
            path: 'docs/obsolete.txt',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      let prPosts = 0;
      let baseSha = '';
      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 93 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          if (headRef.startsWith('loopwright/memory/')) {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 62,
              html_url: 'https://github.invalid/acme/repo/pull/62',
              head: { ref: headRef, sha: '0'.repeat(40) },
              base: { ref: 'main', sha: baseSha },
            }));
            return;
          }
          prPosts += 1;
          const remoteLs = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main']);
          const prSha = remoteLs.split(/\s+/)[0]!;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 61,
            html_url: 'https://github.invalid/acme/repo/pull/61',
            head: { ref: 'loopwright/main', sha: prSha },
            base: { ref: 'main', sha: baseSha },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: classic-delete
spec:
  goal:
    candidate: Classic deletion check
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: classic delete"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init classic repo']);
      baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      const res = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 93,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-classic-delete',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_classic_del_secret_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-classic-del-token-1234',
        },
      });
      assert.equal(res.kind, 'compiled', `unexpected result: ${JSON.stringify(res)}`);
      assert.equal(res.delegateOutcome?.ok, true, `classic delete failed: ${res.delegateOutcome?.detail}`);
      assert.equal(prPosts, 1);
      assert.equal(existsSync(join(repo, '.git', 'worktrees')), false);

      const inspectOut = join(work, 'inspect-classic');
      const inspected = await inspectRun({ runRoot, runId: 'run-classic-delete', output: inspectOut });
      assert.equal(inspected.ok, true);
      const candDoc = JSON.parse(await readFile(join(inspectOut, 'candidate.files.json'), 'utf8')) as {
        manifest: { spec: { baseTree?: unknown; entries: readonly { name: string }[] } };
      };
      assert.equal(candDoc.manifest.spec.baseTree, undefined, 'small repo must use classic manifest mode');

      const prSha = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).split(/\s+/)[0]!;
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);
      const prTree = await git(repo, ['ls-tree', '-r', '--full-tree', prSha]);
      const paths = new Set(prTree.split('\n').map(line => line.split('\t')[1]).filter(Boolean));
      assert.equal(paths.has('docs/obsolete.txt'), false, 'omitted writable file must be deleted from classic PR tree');
      assert.equal(paths.has('docs/keep.txt'), true);
      assert.equal(paths.has('.github/workflows/ci.yml'), true);
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('discovers newer prereleases when allowPrerelease is true, populates recentVersions, and injects upstream/revise context into authorPrompt', async () => {
    const work = await mkdtemp(join(tmpdir(), 'lw-prerelease-prompt-'));
    const repo = join(work, 'repo');
    const runRoot = join(work, 'runs');
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      await mkdir(join(repo, '.loopwright'), { recursive: true });
      await writeFile(join(repo, '.loopwright', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: runner-sync
spec:
  goal:
    candidate: Sync runner upstreams.
    noChange: Verify no upstream drift.
  scope:
    writable:
      - '.autosync/**'
    protected:
      - .github
      - .loopwright
  upstreams:
    - id: vllm-ascend
      kind: github-release
      source: vllm-project/vllm-ascend
      allowPrerelease: true
      watchedPaths: [".autosync/proposal.json"]
    - id: vllm
      kind: github-release
      source: vllm-project/vllm
      watchedPaths: [".autosync/proposal.json"]
  proposal:
    path: .autosync/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: json
        implementation: json-artifact.v1
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
    commentCommands: [revise, retry, status]
    commentPrefixes: ["/auto-sync"]
`);

      server = await startHttpServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/api/repos/vllm-project/vllm-ascend/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v0.16.0', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-ascend/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { tag_name: 'v0.19.0-draft', prerelease: true, draft: true },
            { tag_name: 'v0.18.0rc1', prerelease: true, draft: false },
            { tag_name: 'v0.17.0rc2', prerelease: true, draft: false },
            { tag_name: 'v0.16.0', prerelease: false, draft: false },
          ]));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v0.19.1', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { tag_name: 'v0.20.0rc1', prerelease: true, draft: false },
            { tag_name: 'v0.19.1', prerelease: false, draft: false },
            { tag_name: 'v0.19.0', prerelease: false, draft: false },
          ]));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.loopwright', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const discovered = await discoverTaskpackUpstreams(manifest, {
        repositoryRoot: repo,
        apiBaseUrl: `${server.url}/api`,
        githubToken: 'ghp_test_prerelease_secret',
      });
      assert.deepEqual(discovered, [
        {
          upstreamId: 'vllm-ascend',
          status: 'available',
          version: 'v0.18.0rc1',
          recentVersions: ['v0.18.0rc1', 'v0.17.0rc2', 'v0.16.0'],
        },
        {
          upstreamId: 'vllm',
          status: 'available',
          version: 'v0.19.1',
          recentVersions: ['v0.19.1', 'v0.19.0'],
        },
      ]);

      const promptEnv = {
        ...process.env,
        LOOPWRIGHT_PROVIDER_TOKEN: 'sk-prompt-inject-test-1234',
        LOOPWRIGHT_PUBLICATION_SIGNING_SECRET: 'pub-sign-secret-1234',
      };
      const discoverCompiled = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        baseRevision: 'a'.repeat(40),
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-prompt-discover',
        dryRun: true,
        upstreamRecords: discovered,
        publicationEndpoint: {
          id: 'pub',
          url: 'https://publisher.example.test/publish',
          signingCredentialRef: 'pub-signing',
        },
        env: {
          ...promptEnv,
          PACK_RUN_URL: 'https://github.com/gpustack/runner/actions/runs/43573667865',
        },
      });
      assert.equal(discoverCompiled.kind, 'compiled');
      if (discoverCompiled.kind === 'compiled') {
        const authorHandler = discoverCompiled.taskpack.registry.spec.handlers.find(h => h.implementation === 'pi.agent.v1');
        const promptText = String(authorHandler?.parameters['prompt'] ?? '');
        assert.ok(promptText.includes('v0.18.0rc1'), promptText);
        assert.ok(promptText.includes('v0.19.1'), promptText);
        assert.ok(promptText.includes('https://github.com/gpustack/runner/actions/runs/43573667865'), promptText);
        assert.equal(promptText.includes('sk-prompt-inject-test-1234'), false);
      }

      const reviseCompiled = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'b'.repeat(40),
        mode: 'candidate',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 420, pull_request: { head: { sha: 'b'.repeat(40) } } },
          comment: {
            id: 778899,
            body: '/auto-sync revise\nKeep CUDA vLLM at 0.19.0 and drop ROCm changes.',
            author_association: 'MEMBER',
            user: { login: 'thxcode', type: 'User' },
          },
        },
        runRoot,
        runId: 'run-prompt-revise',
        dryRun: true,
        publicationEndpoint: {
          id: 'pub',
          url: 'https://publisher.example.test/publish',
          signingCredentialRef: 'pub-signing',
        },
        env: {
          ...promptEnv,
          PACK_RUN_URL: 'https://github.com/evil/other/actions/runs/999',
        },
      });
      assert.equal(reviseCompiled.kind, 'compiled');
      if (reviseCompiled.kind === 'compiled') {
        const authorHandler = reviseCompiled.taskpack.registry.spec.handlers.find(h => h.implementation === 'pi.agent.v1');
        const promptText = String(authorHandler?.parameters['prompt'] ?? '');
        assert.ok(promptText.includes('<operator_guidance>'), promptText);
        assert.ok(promptText.includes('Keep CUDA vLLM at 0.19.0 and drop ROCm changes.'), promptText);
        assert.equal(promptText.includes('evil/other'), false, 'cross-repository PACK_RUN_URL must never be injected');
      }
    } finally {
      await server?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects untagged SemVer / PEP-440 prerelease tags when allowPrerelease is false while keeping post-releases and allowPrerelease: true intact', async () => {
    for (const tag of [
      'v0.33.0rc3',
      '0.32.0rc1',
      'v1.0.0-rc.1',
      'v2.0.0-rc.1',
      'v1.0.0-alpha.2',
      'v1.0.0-beta1',
      'v1.0.0.dev3',
      'v1.0.0-pre.1',
      'v1.0.0-preview1',
      'v1.0.0-nightly.20261116',
      'v1.0.0a1',
      'v1.0.0b2',
      '  V0.33.0RC3  ',
    ]) {
      assert.equal(isPrereleaseVersionTag(tag), true, `expected prerelease tag: ${tag}`);
    }
    for (const tag of [
      'v0.32.0',
      'v0.5.23',
      'v0.5.5.post1',
      'v0.5.5-post1',
      '1.0.0.post1',
      'v1.2.3+b100',
      'v1.2.3+dev1',
    ]) {
      assert.equal(isPrereleaseVersionTag(tag), false, `expected stable tag: ${tag}`);
    }

    const work = await mkdtemp(join(tmpdir(), 'lw-untagged-prerelease-'));
    const repo = join(work, 'repo');
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: untagged-prerelease-filter
spec:
  goal:
    candidate: Sync runner upstreams.
    noChange: Verify no upstream drift.
  scope:
    writable:
      - 'pack/**'
    protected:
      - .github
  upstreams:
    - id: vllm-stable
      kind: github-release
      source: vllm-project/vllm
      allowPrerelease: false
      watchedPaths: ["pack/proposal.json"]
    - id: vllm-post
      kind: github-release
      source: vllm-project/post-release
      allowPrerelease: false
      watchedPaths: ["pack/proposal.json"]
    - id: vllm-pre
      kind: github-release
      source: vllm-project/vllm
      allowPrerelease: true
      watchedPaths: ["pack/proposal.json"]
    - id: vllm-tags-stable
      kind: git-tag
      source: vllm-project/vllm-tags
      allowPrerelease: false
      watchedPaths: ["pack/proposal.json"]
    - id: vllm-tags-only-pre
      kind: git-tag
      source: vllm-project/vllm-tags-pre
      allowPrerelease: false
      watchedPaths: ["pack/proposal.json"]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`);

      server = await startHttpServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/api/repos/vllm-project/vllm/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v0.33.0rc3', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { tag_name: 'v0.33.0rc3', prerelease: false, draft: false },
            { tag_name: 'v0.33.0-beta.1', prerelease: true, draft: false },
            { tag_name: 'v0.31.5', prerelease: false, draft: false },
            { tag_name: 'v0.32.0', prerelease: false, draft: false },
            { tag_name: 'v0.5.5.post1', prerelease: false, draft: false },
          ]));
          return;
        }
        if (url === '/api/repos/vllm-project/post-release/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v0.5.5.post1', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/post-release/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { tag_name: 'v0.33.0rc3', prerelease: false, draft: false },
            { tag_name: 'v0.5.5.post1', prerelease: false, draft: false },
          ]));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-tags/tags?per_page=100') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { name: 'v0.33.0rc3', commit: { sha: '1'.repeat(40) } },
            { name: 'v0.32.0', commit: { sha: '2'.repeat(40) } },
          ]));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-tags-pre/tags?per_page=100') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([
            { name: 'v0.33.0rc3', commit: { sha: '1'.repeat(40) } },
          ]));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.auto-sync', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const discovered = await discoverTaskpackUpstreams(manifest, {
        repositoryRoot: repo,
        apiBaseUrl: `${server.url}/api`,
        githubToken: 'ghp_test_untagged_prerelease_secret',
      });

      assert.deepEqual(discovered[0], {
        upstreamId: 'vllm-stable',
        status: 'available',
        version: 'v0.32.0',
        recentVersions: ['v0.32.0', 'v0.31.5', 'v0.5.5.post1'],
      });
      assert.deepEqual(discovered[1], {
        upstreamId: 'vllm-post',
        status: 'available',
        version: 'v0.5.5.post1',
        recentVersions: ['v0.5.5.post1'],
      });
      assert.deepEqual(discovered[2], {
        upstreamId: 'vllm-pre',
        status: 'available',
        version: 'v0.33.0rc3',
        recentVersions: ['v0.33.0rc3', 'v0.33.0-beta.1', 'v0.31.5', 'v0.32.0', 'v0.5.5.post1'],
      });
      assert.deepEqual(discovered[3], {
        upstreamId: 'vllm-tags-stable',
        status: 'available',
        version: 'v0.32.0',
      });
      assert.equal(discovered[4]?.upstreamId, 'vllm-tags-only-pre');
      assert.equal(discovered[4]?.status, 'failed');
    } finally {
      await server?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('refuses empty initial PR branch push in startNativePullRequestPublisherServer when candidate tree matches baseTreeOid', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-empty-pr-refuse-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let pubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Update proposal if needed.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');

      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      let postPullsCalled = 0;
      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 99 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          postPullsCalled += 1;
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Validation Failed', errors: [{ message: 'No commits between main and auto-sync/main' }] }));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: empty-pr-refuse
spec:
  goal:
    candidate: Sync pack
    noChange: No change
  scope:
    writable:
      - 'pack/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: empty pr refuse"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      const runResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 99,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-empty-pr-refuse',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_empty_pr_refuse_secret_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-empty-pr-refuse-token-1234',
        },
      });
      assert.equal(runResult.kind, 'compiled', `unexpected runResult: ${JSON.stringify(runResult)}`);
      assert.equal(runResult.delegateOutcome?.detail.includes('reconcile_required'), false);
      assert.equal(postPullsCalled, 0);
      assert.equal(await git(repo, ['ls-remote', bareRemote, 'refs/heads/auto-sync/*']), '');

      const inspectOut = join(work, 'inspect-empty-pr');
      const inspected = await inspectRun({ runRoot, runId: 'run-empty-pr-refuse', output: inspectOut });
      assert.equal(inspected.ok, true);
      const publicationDoc = JSON.parse(await readFile(join(inspectOut, 'publication.json'), 'utf8')) as {
        status: string;
        receipt: { outcome: string };
      };
      assert.equal(publicationDoc.receipt.outcome, 'not_executed');
      const runResultDoc = JSON.parse(await readFile(join(inspectOut, 'result.json'), 'utf8')) as {
        spec: { subject: { candidateDigest: { hex: string } } };
      };

      pubServer = await startNativePullRequestPublisherServer({
        runRoot,
        repositoryRoot: repo,
        repositoryFullName: 'acme/repo',
        targetBranch: 'main',
        headBranchPrefix: 'auto-sync/',
        remoteUrl: bareRemote,
        apiBaseUrl: githubServer.url,
        gitWriteToken: 'ghp_empty_pr_refuse_secret_1234',
      });
      const rawBody = Buffer.from(JSON.stringify({
        storeId: 'store',
        runId: 'run-empty-pr-refuse',
        lockHash: null,
        operationId: 'op-empty-pr-1',
        dispatchId: 'disp-empty-pr-1',
        dispatchGeneration: 1,
        idempotencyKey: 'idem-empty-pr-1',
        candidateDigest: runResultDoc.spec.subject.candidateDigest.hex,
      }), 'utf8');
      const pubResponse = await fetch(pubServer.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${pubServer.authToken}`,
          'x-loopwright-signature': signPayload(pubServer.signingSecret, rawBody),
        },
        body: rawBody,
      });
      assert.equal(pubResponse.status, 200);
      const rawReceiptText = await pubResponse.text();
      assert.equal(
        pubResponse.headers.get('x-loopwright-signature'),
        signPayload(pubServer.signingSecret, Buffer.from(rawReceiptText, 'utf8')),
      );
      const receipt = JSON.parse(rawReceiptText) as { outcome: string; externalUrl: string | null; reason: string | null };
      assert.equal(receipt.outcome, 'not_executed');
      assert.equal(receipt.externalUrl, null);
      assert.match(receipt.reason ?? '', /candidate tree matches base tree/);
      assert.equal(postPullsCalled, 0);
      assert.equal(await git(repo, ['ls-remote', bareRemote, 'refs/heads/auto-sync/*']), '');
    } finally {
      await pubServer?.close();
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('discoverTaskpackUpstreams treats SemVer resolved <= baseline as up_to_date and resolved > baseline as available', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-semver-baseline-')));
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      const repo = join(work, 'repo');
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'instructions.md'), '# Sync\n');
      await writeFile(
        join(repo, 'pack', 'proposal.json'),
        JSON.stringify({
          schema_version: 1,
          upstreams: {
            vllm_older: 'v0.33.0',
            vllm_newer: 'v0.33.0',
            vllm_tag_older: 'v0.33.0',
            vllm_build_meta: 'v1.2.3+build.1',
          },
        }) + '\n',
      );
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: semver-baseline-check
spec:
  goal:
    candidate: Sync pack
    noChange: No change
  scope:
    writable: ['pack/**']
  instructions: [.auto-sync/instructions.md]
  upstreams:
    - id: vllm_older
      kind: github-release
      source: vllm-project/vllm-older
      watchedPaths: [pack]
    - id: vllm_newer
      kind: github-release
      source: vllm-project/vllm-newer
      watchedPaths: [pack]
    - id: vllm_tag_older
      kind: git-tag
      source: vllm-project/vllm-tag-older
      watchedPaths: [pack]
    - id: vllm_build_meta
      kind: github-release
      source: vllm-project/vllm-build-meta
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version]
    schemaVersion: 1
  verification:
    localChecks:
      - id: json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: sync"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`);

      server = await startHttpServer((req, res) => {
        const url = req.url ?? '';
        if (url === '/api/repos/vllm-project/vllm-older/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v0.32.0', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-older/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{ tag_name: 'v0.32.0', prerelease: false, draft: false }]));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-newer/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v0.34.0', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-newer/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{ tag_name: 'v0.34.0', prerelease: false, draft: false }]));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-tag-older/tags?per_page=100') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{ name: 'v0.32.0', commit: { sha: '2'.repeat(40) } }]));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-build-meta/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v1.2.3+build.2', prerelease: false, draft: false }));
          return;
        }
        if (url === '/api/repos/vllm-project/vllm-build-meta/releases?per_page=30') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([{ tag_name: 'v1.2.3+build.2', prerelease: false, draft: false }]));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.auto-sync', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const discovered = await discoverTaskpackUpstreams(manifest, {
        repositoryRoot: repo,
        apiBaseUrl: `${server.url}/api`,
      });

      assert.equal(discovered[0]?.upstreamId, 'vllm_older');
      assert.equal(discovered[0]?.status, 'up_to_date');
      assert.equal(discovered[0]?.version, 'v0.32.0');

      assert.equal(discovered[1]?.upstreamId, 'vllm_newer');
      assert.equal(discovered[1]?.status, 'available');
      assert.equal(discovered[1]?.version, 'v0.34.0');

      assert.equal(discovered[2]?.upstreamId, 'vllm_tag_older');
      assert.equal(discovered[2]?.status, 'up_to_date');
      assert.equal(discovered[2]?.version, 'v0.32.0');

      assert.equal(discovered[3]?.upstreamId, 'vllm_build_meta');
      assert.equal(discovered[3]?.status, 'available');
      assert.equal(discovered[3]?.version, 'v1.2.3+build.2');
    } finally {
      await server?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('accepts verified unchanged candidate no_change submission in turnkey candidate mode when implicit no_change and scope checks pass', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-candidate-no-change-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Verify upstream and submit no_change if unchanged.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');

      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'no_change', checks: [], reason: 'candidate unchanged' })));
      });

      let postPullsCalled = 0;
      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 99 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          postPullsCalled += 1;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ number: 1, html_url: 'https://github.com/acme/repo/pull/1' }));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: candidate-no-change-accept
spec:
  goal:
    candidate: Sync pack
    noChange: No change
  scope:
    writable:
      - 'pack/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore: candidate no change"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      let capturedReport: {
        readonly report?: {
          readonly status: string;
          readonly reasonCode?: string | null;
          readonly detail?: string | null;
        };
      } | undefined;
      const runResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 99,
        baseRevision: baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-candidate-no-change',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_candidate_no_change_secret_1234',
        gitRemoteUrl: bareRemote,
        onTurnkeyReport: info => {
          capturedReport = info as typeof capturedReport;
        },
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-candidate-no-change-token-1234',
        },
      });
      assert.equal(runResult.kind, 'compiled', `unexpected runResult: ${JSON.stringify(runResult)}`);
      assert.equal(runResult.delegateOutcome?.ok, true);
      assert.match(runResult.delegateOutcome?.detail ?? '', /settled as no_change \(candidate unchanged\)/);
      assert.equal(capturedReport?.report?.status, 'no_change');
      assert.equal(capturedReport?.report?.reasonCode, null);
      assert.equal(capturedReport?.report?.detail, null);
      assert.equal(postPullsCalled, 0);
      assert.equal(await git(repo, ['ls-remote', bareRemote, 'refs/heads/auto-sync/*']), '');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('exposes optional source-revision in action.yml and materializes >128-file tree_overlay INPUT_SOURCE-REVISION with baseSha authority across command.v1 and PR publication', async () => {
    let repoRoot = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(repoRoot, 'action.yml')) && existsSync(join(repoRoot, 'package.json'))) break;
      const parent = resolve(repoRoot, '..');
      if (parent === repoRoot) break;
      repoRoot = parent;
    }
    const actionYmlRaw = await readFile(join(repoRoot, 'action.yml'), 'utf8');
    const actionDoc = parseYaml(actionYmlRaw, { uniqueKeys: true }) as {
      inputs?: Record<string, { required?: boolean; description?: string }>;
      runs?: { steps?: Array<{ id?: string; env?: Record<string, string> }> };
    };
    const sourceRevInput = actionDoc.inputs?.['source-revision'];
    assert.ok(sourceRevInput, 'action.yml must declare inputs.source-revision');
    assert.equal(sourceRevInput.required, false);
    assert.equal(typeof sourceRevInput.description, 'string');
    assert.ok((sourceRevInput.description ?? '').trim().length > 0);
    const entrypointStep = actionDoc.runs?.steps?.find(step => step.id === 'loopwright-entrypoint');
    assert.equal(
      entrypointStep?.env?.['INPUT_SOURCE-REVISION'],
      '${{ inputs.source-revision }}',
      'action.yml must wire INPUT_SOURCE-REVISION: ${{ inputs.source-revision }}',
    );

    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-cli-source-rev-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'pack', 'items'), { recursive: true });
      await mkdir(join(repo, 'vendor'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: base-ci\n');
      await writeFile(join(repo, 'README.md'), 'base-readme\n');
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Add vendor overlay note.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, 'vendor', 'README.md'), 'vendor baseline\n');
      await writeFile(join(repo, 'vendor', 'stale.txt'), 'stale-content\n');
      for (let i = 0; i < 135; i += 1) {
        await writeFile(join(repo, 'pack', 'items', `item-${String(i).padStart(3, '0')}.txt`), `item-${i}\n`);
      }

      const verifyScript = `#!/usr/bin/env bash
set -euo pipefail
test "$(cat pack/items/item-134.txt)" = "item-134"
test "$(cat .github/workflows/ci.yml)" = "name: base-ci"
test "$(cat README.md)" = "base-readme"
if [[ -f vendor/subchart/overlay-note.txt ]]; then
  test "$(cat vendor/subchart/Chart.yaml)" = $'apiVersion: v2\\nname: subchart\\nversion: 1.2.3'
  test "$(cat vendor/subchart/values.yaml)" = $'replicaCount: 2\\nimage:\\n  tag: v1.2.3'
  test "$(cat vendor/README.md)" = "vendor preflight updated"
  test ! -e vendor/stale.txt
  test "$(cat vendor/subchart/overlay-note.txt)" = "agent overlay edit"
fi
`;
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), verifyScript, { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      let mode: 'completed' | 'no_change' = 'completed';
      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        let sseBody: string;
        if (mode === 'no_change') {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'no_change', checks: [], reason: 'whitespace source-revision fallback' }));
        } else if (step === 0) {
          // Intentionally do NOT re-touch pack/proposal.json so it is carried from sourceRev via carryUpdates.
          sseBody = sseToolCall('gpt-4.1-mini', 'sr-1', 'write', {
            path: 'vendor/subchart/overlay-note.txt',
            content: 'agent overlay edit\n',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      let baseSha = '';
      let prPosts = 0;
      let createdPrBody = '';
      let openPrHeadSha = '';
      githubServer = await startHttpServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 707 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          const payload = await readJsonBody(req);
          const headRef = String(payload['head'] ?? '');
          if (headRef.startsWith('loopwright/memory/')) {
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: 102,
              html_url: 'https://github.invalid/acme/repo/pull/102',
              head: { ref: headRef, sha: '0'.repeat(40) },
              base: { ref: 'main', sha: baseSha },
            }));
            return;
          }
          prPosts += 1;
          createdPrBody = String(payload['body'] ?? '');
          const remoteLs = await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main']);
          openPrHeadSha = remoteLs.split(/\s+/)[0]!;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 101,
            html_url: 'https://github.invalid/acme/repo/pull/101',
            head: { ref: 'loopwright/main', sha: openPrHeadSha },
            base: { ref: 'main', sha: baseSha },
          }));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: cli-source-revision
spec:
  goal:
    candidate: Sync vendor subchart from preflight source revision
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'vendor/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 15
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: source revision sync"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base main commit']);
      baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      // Stage bulk writable vendor files, carried proposal, removal, AND tampered protected/non-writable files on detached sourceRev.
      await git(repo, ['checkout', '--detach', baseSha]);
      await mkdir(join(repo, 'vendor', 'subchart'), { recursive: true });
      const stagedChartYaml = 'apiVersion: v2\nname: subchart\nversion: 1.2.3\n';
      const stagedValuesYaml = 'replicaCount: 2\nimage:\n  tag: v1.2.3\n';
      const stagedProposal = {
        schema_version: 1,
        version: '2.0.0',
        summary: 'Preflight staged vendor subchart update.',
        subscriptions: [
          {
            subscription: 'acme/engine',
            status: 'updated',
            engine_version: '2.0.0',
            plugin_version: '1.2.3',
            reason: 'Synced via source-revision.',
          },
        ],
      };
      await writeFile(join(repo, 'pack', 'proposal.json'), `${JSON.stringify(stagedProposal)}\n`);
      await writeFile(join(repo, 'vendor', 'subchart', 'Chart.yaml'), stagedChartYaml);
      await writeFile(join(repo, 'vendor', 'subchart', 'values.yaml'), stagedValuesYaml);
      await writeFile(join(repo, 'vendor', 'README.md'), 'vendor preflight updated\n');
      await rm(join(repo, 'vendor', 'stale.txt'));
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: tampered-in-source-rev\n');
      await writeFile(join(repo, 'README.md'), 'tampered-readme-in-source-rev\n');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-m', 'preflight: stage vendor subchart']);
      const sourceRev = await git(repo, ['rev-parse', 'HEAD']);
      assert.notEqual(sourceRev, baseSha);

      await git(repo, ['checkout', 'main']);
      assert.equal(await git(repo, ['rev-parse', 'HEAD']), baseSha);

      const exitCode = await runActionCli(
        {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: repo,
          LOOPWRIGHT_REPOSITORY: 'acme/repo',
          GITHUB_SHA: baseSha,
          GITHUB_API_URL: githubServer.url,
          'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
          'INPUT_MODE': 'candidate',
          'INPUT_EVENT-NAME': 'workflow_dispatch',
          'INPUT_RUN-ROOT': runRoot,
          'INPUT_RUN-ID': 'run-cli-source-rev',
          'INPUT_DRY-RUN': 'false',
          'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
          'INPUT_GITHUB-TOKEN': 'ghp_cli_source_rev_secret_1234',
          'INPUT_REMOTE-URL': bareRemote,
          'INPUT_SOURCE-REVISION': sourceRev,
          LLM_TOKEN: 'sk-cli-source-rev-token-1234',
        },
        { openHostSessionAdapter: fastAdapter },
      );

      assert.equal(exitCode, 0, 'runActionCli with INPUT_SOURCE-REVISION must exit 0');
      assert.equal(prPosts, 1);

      // a) Inspect candidate.files.json: version 2 tree_overlay anchored at sourceRev containing ONLY the agent overlay edit.
      const inspectOut = join(work, 'inspect-source-rev');
      const inspected = await inspectRun({ runRoot, runId: 'run-cli-source-rev', output: inspectOut });
      assert.equal(inspected.ok, true);
      const candidateFilesDoc = JSON.parse(await readFile(join(inspectOut, 'candidate.files.json'), 'utf8')) as {
        manifest: {
          spec: {
            baseTree?: { commitOid: string; treeOid: string };
            entries: readonly { name: string }[];
          };
        };
      };
      assert.equal(candidateFilesDoc.manifest.spec.baseTree?.commitOid, sourceRev);
      assert.deepEqual(
        candidateFilesDoc.manifest.spec.entries.map(e => e.name),
        ['vendor/subchart/overlay-note.txt'],
        'candidate.files.json must contain only the agent overlay edit, not 135 baseline or untouched sourceRev files',
      );

      // c) PR body must still render summary & subscriptions table from carried pack/proposal.json.
      assert.match(createdPrBody, /Preflight staged vendor subchart update\./);
      assert.match(createdPrBody, /\| acme\/engine \| updated \| 2\.0\.0 \| 1\.2\.3 \| Synced via source-revision\. \|/);

      const prHeadSha = (await git(repo, ['ls-remote', bareRemote, 'refs/heads/loopwright/main'])).split(/\s+/)[0]!;
      assert.match(prHeadSha, /^[0-9a-f]{40}$/);
      await git(repo, ['fetch', bareRemote, 'refs/heads/loopwright/main']);

      // Single squashed PR commit parented solely on baseSha (NOT sourceRev).
      const revParents = (await git(repo, ['rev-list', '--parents', '-n', '1', prHeadSha])).trim().split(/\s+/);
      assert.deepEqual(
        revParents,
        [prHeadSha, baseSha],
        'pushed PR head commit must have baseSha as its sole parent, not sourceRev',
      );

      // Verify writable sourceRev additions/updates/removals + agent overlay + baseSha authority on protected/non-writable paths.
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:vendor/subchart/Chart.yaml`]),
        stagedChartYaml.trimEnd(),
      );
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:vendor/subchart/values.yaml`]),
        stagedValuesYaml.trimEnd(),
      );
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:vendor/README.md`]),
        'vendor preflight updated',
      );
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:vendor/subchart/overlay-note.txt`]),
        'agent overlay edit',
      );
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:pack/proposal.json`]),
        JSON.stringify(stagedProposal),
      );
      await assert.rejects(
        () => git(repo, ['cat-file', '-e', `${prHeadSha}:vendor/stale.txt`]),
        'writable file deleted in sourceRev must remain absent in PR head',
      );
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:.github/workflows/ci.yml`]),
        'name: base-ci',
        'protected path modified in sourceRev must retain baseSha content',
      );
      assert.equal(
        await git(repo, ['cat-file', 'blob', `${prHeadSha}:README.md`]),
        'base-readme',
        'non-writable path modified in sourceRev must retain baseSha content',
      );

      // Whitespace-only INPUT_SOURCE-REVISION must trim to undefined and fall back cleanly to baseRevision without ACTION_INPUT_INVALID.
      mode = 'no_change';
      turn = 0;
      const blankExitCode = await runActionCli(
        {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          GITHUB_WORKSPACE: repo,
          LOOPWRIGHT_REPOSITORY: 'acme/repo',
          GITHUB_SHA: baseSha,
          GITHUB_API_URL: githubServer.url,
          'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
          'INPUT_MODE': 'candidate',
          'INPUT_EVENT-NAME': 'workflow_dispatch',
          'INPUT_RUN-ROOT': runRoot,
          'INPUT_RUN-ID': 'run-cli-source-rev-blank',
          'INPUT_DRY-RUN': 'false',
          'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
          'INPUT_GITHUB-TOKEN': 'ghp_cli_source_rev_secret_1234',
          'INPUT_REMOTE-URL': bareRemote,
          'INPUT_SOURCE-REVISION': '   ',
          LLM_TOKEN: 'sk-cli-source-rev-token-1234',
        },
        { openHostSessionAdapter: fastAdapter },
      );
      assert.equal(blankExitCode, 0, 'whitespace-only INPUT_SOURCE-REVISION must trim to undefined and fall back to baseRevision');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('enforces baseRevision authority on protected and non-writable paths inside startLocalCommandGateServer even in classic <=128-file mode', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-classic-gate-auth-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await mkdir(join(repo, 'vendor'), { recursive: true });
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: base-ci\n');
      await writeFile(join(repo, 'README.md'), 'base-readme\n');
      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Update vendor note.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, 'vendor', 'keep.txt'), 'base-keep\n');
      await writeFile(join(repo, 'vendor', 'drop.txt'), 'drop-me\n');

      const verifyScript = `#!/usr/bin/env bash
set -euo pipefail
test "$(cat .github/workflows/ci.yml)" = "name: base-ci"
test "$(cat README.md)" = "base-readme"
test "$(cat vendor/keep.txt)" = "source-keep"
test ! -e vendor/drop.txt
test "$(cat vendor/agent.txt)" = "agent-added"
`;
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), verifyScript, { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const step = turn++;
        const sseBody = step === 0
          ? sseToolCall('gpt-4.1-mini', 'cl-1', 'write', {
              path: 'vendor/agent.txt',
              content: 'agent-added\n',
            })
          : sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 708 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: classic-source-rev-gate
spec:
  goal:
    candidate: Enforce baseRevision authority in classic command.v1 gate
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'vendor/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
      - id: verify-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
          timeoutSeconds: 15
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: classic source rev"
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
  output:
    formats: [json]
`);

      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base commit']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['checkout', '--detach', baseSha]);
      await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'name: tampered-ci\n');
      await writeFile(join(repo, 'README.md'), 'tampered-readme\n');
      await writeFile(join(repo, 'vendor', 'keep.txt'), 'source-keep\n');
      await rm(join(repo, 'vendor', 'drop.txt'));
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-m', 'sourceRev commit']);
      const sourceRev = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', 'main']);

      const result = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 708,
        baseRevision: baseSha,
        sourceRevision: sourceRev,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-classic-gate-auth',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-classic-gate-token-1234',
        },
      });
      assert.equal(result.kind, 'compiled', `unexpected result: ${JSON.stringify(result)}`);
      assert.equal(result.delegateOutcome?.ok, true, `classic command.v1 gate failed: ${result.delegateOutcome?.detail}`);

      const inspectOut = join(work, 'inspect-classic');
      const inspected = await inspectRun({ runRoot, runId: 'run-classic-gate-auth', output: inspectOut });
      assert.equal(inspected.ok, true);
      const candidateFilesDoc = JSON.parse(await readFile(join(inspectOut, 'candidate.files.json'), 'utf8')) as {
        manifest: { spec: { baseTree?: unknown } };
      };
      assert.equal(candidateFilesDoc.manifest.spec.baseTree, undefined, '<=128 files must enter classic mode');
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('normalizes and resolves source-revision in dry-run mode on git repos while keeping non-git fixtures working', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-dryrun-source-rev-')));
    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Dry run source revision.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: dryrun-source-rev
spec:
  goal:
    candidate: Dry run source revision resolution
    noChange: No change
  scope:
    writable:
      - 'pack/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: dryrun"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  output:
    formats: [json]
`);
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'first commit']);
      const firstSha = await git(repo, ['rev-parse', 'HEAD']);

      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.1' }) + '\n');
      await git(repo, ['add', 'pack/proposal.json']);
      await git(repo, ['commit', '-m', 'second commit']);
      const secondSha = await git(repo, ['rev-parse', 'HEAD']);

      // 1) Valid ref expression HEAD~1 resolves to firstSha in INPUT_DRY-RUN=true.
      const resolvedDryExit = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: repo,
        LOOPWRIGHT_REPOSITORY: 'acme/repo',
        GITHUB_SHA: secondSha,
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_MODE': 'candidate',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'run-dry-head1',
        'INPUT_DRY-RUN': 'true',
        'INPUT_SOURCE-REVISION': 'HEAD~1',
        'INPUT_UPSTREAM-RECORDS': JSON.stringify([{ upstreamId: 'engine', status: 'available', version: '2.0.0' }]),
      });
      assert.equal(resolvedDryExit, 0, 'dry-run with HEAD~1 must resolve and succeed');

      // Direct entrypoint with runtimeEnv['INPUT_SOURCE-REVISION'] fallback and HEAD~1 resolution.
      const directRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        baseRevision: secondSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-dry-direct',
        dryRun: true,
        turnkey: false,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          'INPUT_SOURCE-REVISION': '  HEAD~1  ',
        },
      });
      assert.equal(directRes.kind, 'compiled');
      const compiledConfig = parseYaml(await readFile(directRes.taskpack.configPath, 'utf8')) as {
        spec: { task: { spec: { target: { baseRevision: string; sourceRevision: string } } } };
      };
      assert.equal(compiledConfig.spec.task.spec.target.baseRevision, secondSha);
      assert.equal(compiledConfig.spec.task.spec.target.sourceRevision, firstSha, 'resolved HEAD~1 SHA must be bound in compiled TaskContract');

      // 2) Whitespace-only direct sourceRevision trims to undefined and falls back to baseRevision.
      const whitespaceRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        baseRevision: secondSha,
        sourceRevision: '   ',
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-dry-ws',
        dryRun: true,
        turnkey: false,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
      });
      assert.equal(whitespaceRes.kind, 'compiled');

      // 3) Missing ref and nonexistent 40-hex SHA both fail closed in dry-run mode.
      const missingRefRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        baseRevision: secondSha,
        sourceRevision: 'refs/heads/does-not-exist',
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-dry-missing-ref',
        dryRun: true,
        turnkey: false,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
      });
      assert.equal(missingRefRes.kind, 'blocked');
      assert.equal(missingRefRes.reason, 'ACTION_INPUT_INVALID');

      const missingShaRes = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        baseRevision: secondSha,
        sourceRevision: 'f'.repeat(40),
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-dry-missing-sha',
        dryRun: true,
        turnkey: false,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
      });
      assert.equal(missingShaRes.kind, 'blocked');
      assert.equal(missingShaRes.reason, 'ACTION_INPUT_INVALID');

      // 4) Non-git synthetic directory keeps working when .git does not exist.
      const nonGitRepo = join(work, 'non-git');
      await cp(repo, nonGitRepo, {
        recursive: true,
        filter: src => !src.endsWith('/.git') && !src.includes('/.git/'),
      });
      const nonGitRes = await runGitHubActionEntrypoint({
        repositoryRoot: nonGitRepo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'b'.repeat(40),
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-dry-nongit',
        dryRun: true,
        turnkey: false,
        upstreamRecords: [{ upstreamId: 'engine', status: 'available', version: '2.0.0' }],
      });
      assert.equal(nonGitRes.kind, 'compiled');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('preserves explicit source-revision on issue_comment /loopwright retry while binding revise and unpinned retry to PR base/head', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-comment-retry-sr-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;

    try {
      const repo = join(work, 'repo');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await mkdir(join(repo, 'vendor'), { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Retry or revise.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, 'vendor', 'note.txt'), 'base\n');

      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      let prBaseSha = '';
      let prHeadSha = '';
      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 709 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls/12') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 12,
            base: { ref: 'main', sha: prBaseSha },
            head: { ref: 'loopwright/main', sha: prHeadSha },
          }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: comment-retry-source-rev
spec:
  goal:
    candidate: Comment command source revision resolution
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'vendor/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: comment retry"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
    commentPrefixes:
      - /loopwright
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiServer.url}/v1
      cost:
        input: 1
        output: 2
  output:
    formats: [json]
`);
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'prBaseSha']);
      prBaseSha = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['checkout', '--detach', prBaseSha]);
      await writeFile(join(repo, 'vendor', 'note.txt'), 'pr-head\n');
      await git(repo, ['add', 'vendor/note.txt']);
      await git(repo, ['commit', '-m', 'prHeadSha']);
      prHeadSha = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['checkout', 'main']);
      await writeFile(join(repo, 'vendor', 'note.txt'), 'new-main\n');
      await git(repo, ['add', 'vendor/note.txt']);
      await git(repo, ['commit', '-m', 'mainSha']);
      const mainSha = await git(repo, ['rev-parse', 'HEAD']);

      await git(repo, ['checkout', '--detach', mainSha]);
      await writeFile(join(repo, 'vendor', 'note.txt'), 'preflight-retry\n');
      await git(repo, ['add', 'vendor/note.txt']);
      await git(repo, ['commit', '-m', 'explicitSourceRev']);
      const explicitSourceRev = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', 'main']);

      const makeCommentPayload = (bodyText: string) => ({
        action: 'created',
        issue: { number: 12, pull_request: {} },
        comment: { id: 901, body: bodyText, author_association: 'MEMBER', user: { login: 'maintainer' } },
      });

      const runCase = async (runId: string, bodyText: string, sourceRevision?: string) => {
        const res = await runGitHubActionEntrypoint({
          repositoryRoot: repo,
          taskpackPath: '.auto-sync/taskpack.yaml',
          repositoryFullName: 'acme/repo',
          repositoryId: 709,
          baseRevision: mainSha,
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          mode: 'candidate',
          eventName: 'issue_comment',
          eventPayload: makeCommentPayload(bodyText),
          runRoot,
          runId,
          turnkey: true,
          allowManifestCustomBaseUrl: true,
          openHostSessionAdapter: fastAdapter,
          githubApiBaseUrl: githubServer!.url,
          env: {
            PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
            GITHUB_ACTIONS: 'true',
            LLM_TOKEN: 'sk-comment-retry-token-1234',
          },
        });
        assert.equal(res.kind, 'compiled', `unexpected result for ${runId}: ${JSON.stringify(res)}`);
        const inspectOut = join(work, `inspect-${runId}`);
        const inspected = await inspectRun({ runRoot, runId, output: inspectOut });
        assert.equal(inspected.ok, true);
        const lockDoc = JSON.parse(await readFile(join(inspectOut, 'task.lock.json'), 'utf8')) as {
          spec: { contract: { spec: { target: { baseRevision: string; sourceRevision: string } } } };
        };
        return lockDoc.spec.contract.spec.target;
      };

      // 1) /loopwright retry WITH explicit sourceRevision preserves (mainSha, explicitSourceRev).
      const retryExplicit = await runCase('run-comment-retry-explicit', '/loopwright retry', explicitSourceRev);
      assert.deepEqual(
        { baseRevision: retryExplicit.baseRevision, sourceRevision: retryExplicit.sourceRevision },
        { baseRevision: mainSha, sourceRevision: explicitSourceRev },
      );

      // 2) /loopwright retry WITHOUT explicit sourceRevision preserves existing (prBaseSha, prHeadSha) behavior.
      const retryDefault = await runCase('run-comment-retry-default', '/loopwright retry');
      assert.deepEqual(
        { baseRevision: retryDefault.baseRevision, sourceRevision: retryDefault.sourceRevision },
        { baseRevision: prBaseSha, sourceRevision: prHeadSha },
      );

      // 3) /loopwright revise WITH explicit sourceRevision MUST still bind (prBaseSha, prHeadSha).
      const reviseExplicit = await runCase('run-comment-revise-explicit', '/loopwright revise fix something', explicitSourceRev);
      assert.deepEqual(
        { baseRevision: reviseExplicit.baseRevision, sourceRevision: reviseExplicit.sourceRevision },
        { baseRevision: prBaseSha, sourceRevision: prHeadSha },
      );
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('resolveRepositoryAndRevisions fails closed on nonexistent 40-hex SHAs in real .git repos while allowing non-git fixtures', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-resolve-sha-git-')));
    let server: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      server = await startHttpServer((req, res) => {
        if (req.url === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 901 }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const gitRepo = join(work, 'git-repo');
      await mkdir(gitRepo, { recursive: true });
      await git(gitRepo, ['init', '-b', 'main']);
      await writeFile(join(gitRepo, 'README.md'), 'hello\n');
      await git(gitRepo, ['add', 'README.md']);
      await git(gitRepo, ['commit', '-m', 'init']);
      const headSha = await git(gitRepo, ['rev-parse', 'HEAD']);

      await assert.rejects(
        () => resolveRepositoryAndRevisions({
          repositoryRoot: gitRepo,
          repositoryFullName: 'acme/repo',
          baseRevision: headSha,
          sourceRevision: 'f'.repeat(40),
          eventName: 'workflow_dispatch',
          apiBaseUrl: server!.url,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );

      const nonGitDir = join(work, 'non-git-dir');
      await mkdir(nonGitDir, { recursive: true });
      const resolvedNonGit = await resolveRepositoryAndRevisions({
        repositoryRoot: nonGitDir,
        repositoryFullName: 'acme/repo',
        baseRevision: 'a'.repeat(40),
        sourceRevision: 'b'.repeat(40),
        eventName: 'workflow_dispatch',
        apiBaseUrl: server.url,
      });
      assert.equal(resolvedNonGit.baseRevision, 'a'.repeat(40));
      assert.equal(resolvedNonGit.sourceRevision, 'b'.repeat(40));

      assert.equal(
        shouldPreserveExplicitSourceRevision({
          eventName: 'issue_comment',
          explicitSourceRevision: headSha,
          commentCommand: 'retry',
        }),
        true,
      );
      assert.equal(
        shouldPreserveExplicitSourceRevision({
          eventName: 'issue_comment',
          explicitSourceRevision: headSha,
          commentCommand: 'revise',
        }),
        false,
      );
      assert.equal(
        shouldPreserveExplicitSourceRevision({
          eventName: 'issue_comment',
          explicitSourceRevision: '   ',
          commentCommand: 'retry',
        }),
        false,
      );
      assert.equal(
        shouldPreserveExplicitSourceRevision({
          eventName: 'pull_request_review',
          explicitSourceRevision: headSha,
          commentCommand: 'retry',
        }),
        false,
      );
    } finally {
      await server?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('emits scrubbed stderr warning when carried proposal exceeds MAX_PROPOSAL_JSON_BYTES in startNativePullRequestPublisherServer', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-carried-proposal-warn-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrChunks: string[] = [];

    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'pack', 'items'), { recursive: true });
      await mkdir(join(repo, 'vendor'), { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Update vendor note only.\n');
      await writeFile(join(repo, '.auto-sync', 'checks', 'pass.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'pass.sh'), 0o755);
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, 'vendor', 'note.txt'), 'base\n');
      for (let i = 0; i < 135; i += 1) {
        await writeFile(join(repo, 'pack', 'items', `item-${String(i).padStart(3, '0')}.txt`), `item-${i}\n`);
      }

      openAiServer = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        if (body['max_tokens'] === 1 && body['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      let prPostCount = 0;
      githubServer = await startHttpServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/repos/acme/engine/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (url.pathname === '/repos/acme/repo') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 710 }));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (url.pathname === '/repos/acme/repo/pulls' && req.method === 'POST') {
          prPostCount += 1;
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: 55,
            html_url: 'https://github.invalid/acme/repo/pull/55',
            head: { ref: 'loopwright/main', sha: '0'.repeat(40) },
            base: { ref: 'main', sha: '0'.repeat(40) },
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: carried-proposal-warn
spec:
  goal:
    candidate: Carried oversize proposal warning
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'vendor/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: pass-cmd
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/pass.sh
          timeoutSeconds: 15
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: carried proposal warn"
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
  output:
    formats: [json]
`);
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'base commit']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      await mkdir(bareRemote, { recursive: true });
      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);
      await git(repo, ['push', '-u', 'origin', 'main']);

      // Create detached sourceRevision where carried pack/proposal.json exceeds MAX_PROPOSAL_JSON_BYTES (2 MiB).
      await git(repo, ['checkout', '--detach', baseSha]);
      const oversizeProposal = JSON.stringify({
        schema_version: 1,
        version: '2.0.0',
        summary: 'x'.repeat(2_200_000),
      });
      await writeFile(join(repo, 'pack', 'proposal.json'), oversizeProposal);
      await git(repo, ['add', 'pack/proposal.json']);
      await git(repo, ['commit', '-m', 'oversize carried proposal']);
      const sourceRev = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['checkout', 'main']);

      process.stderr.write = ((chunk: Uint8Array | string) => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;

      const carriedWarnResult = await runGitHubActionEntrypoint({
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'acme/repo',
        repositoryId: 710,
        baseRevision: baseSha,
        sourceRevision: sourceRev,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'run-carried-proposal-warn',
        turnkey: true,
        allowManifestCustomBaseUrl: true,
        openHostSessionAdapter: fastAdapter,
        githubApiBaseUrl: githubServer.url,
        githubToken: 'ghp_carried_proposal_secret_1234',
        gitRemoteUrl: bareRemote,
        env: {
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          GITHUB_ACTIONS: 'true',
          LLM_TOKEN: 'sk-carried-proposal-token-1234',
        },
      });
      assert.equal(carriedWarnResult.kind, 'compiled', `unexpected result: ${JSON.stringify(carriedWarnResult)}`);
      assert.equal(carriedWarnResult.delegateOutcome?.ok, true, `unexpected delegateOutcome: ${carriedWarnResult.delegateOutcome?.detail}`);
      assert.ok(prPostCount >= 1, `expected PR POST, delegateOutcome=${carriedWarnResult.delegateOutcome?.detail}`);
      const stderrText = stderrChunks.join('');
      assert.match(stderrText, /carried proposal .*pack\/proposal\.json.*exceeds/i);
      assert.equal(stderrText.includes('ghp_carried_proposal_secret_1234'), false);
    } finally {
      process.stderr.write = origStderrWrite;
      await openAiServer?.close();
      await githubServer?.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects missing carried blob OIDs with GitHubAppError ACTION_INPUT_INVALID during gate carry baseline resolution', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-carry-missing-oid-')));
    try {
      const repo = join(work, 'repo');
      await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
      await mkdir(join(repo, 'pack'), { recursive: true });
      await mkdir(join(repo, 'vendor'), { recursive: true });
      await git(repo, ['init', '-b', 'main']);

      await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Verify carry delta.\n');
      await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }) + '\n');
      await writeFile(join(repo, 'vendor', 'keep.txt'), 'base-keep\n');
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: carry-missing-oid
spec:
  goal:
    candidate: Verify carry delta error handling
    noChange: No change
  scope:
    writable:
      - 'pack/**'
      - 'vendor/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths: [pack]
  proposal:
    path: pack/proposal.json
    requiredFields: [schema_version, version]
    schemaVersion: 1
  verification:
    externalGates: []
    localChecks:
      - id: json
        implementation: json-artifact.v1
  publication:
    mode: disabled
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: carry missing oid"
  memory:
    directory: .auto-sync/memory
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
  output:
    formats: [json]
`);
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'init']);
      const baseSha = await git(repo, ['rev-parse', 'HEAD']);

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: join(repo, '.auto-sync', 'taskpack.yaml'),
        repositoryRoot: repo,
      });
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'acme/repo',
        baseRevision: baseSha,
        sourceRevision: baseSha,
        repositoryRoot: repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        budgets: DEFAULT_HOST_BUDGETS,
      });
      const snapshotContext = {
        contract: compiled.config.spec.task,
        protectedPaths: compiled.config.spec.task.spec.scope.protected,
      };

      const presentBlobOid = await gitWithInput(repo, ['hash-object', '-w', '--stdin'], 'carried-present\n');
      const missingBlobOid = 'd'.repeat(40);
      const baseEntries = new Map([
        ['vendor/keep.txt', { mode: '100644', type: 'blob', oid: 'a'.repeat(40) }],
      ]);
      const sourceEntriesPresent = new Map([
        ['vendor/keep.txt', { mode: '100644', type: 'blob', oid: 'a'.repeat(40) }],
        ['vendor/present.txt', { mode: '100644', type: 'blob', oid: presentBlobOid }],
      ]);

      const presentDelta = computeAllowedSourceRevisionCarryDelta(snapshotContext, baseEntries, sourceEntriesPresent);
      assert.deepEqual(presentDelta.carryUpdates, [
        { path: 'vendor/present.txt', mode: '100644', oid: presentBlobOid },
      ]);
      const presentBaseline = new Map<string, { path: string; mode: '100644' | '100755'; oid: string; byteLength: number }>();
      await applyCarryDeltaToEffectiveBaseline(
        repo,
        presentBaseline,
        new Map(),
        presentDelta.carryRemovals,
        presentDelta.carryUpdates,
        GIT_TEST_ENV,
      );
      assert.deepEqual(presentBaseline.get('vendor/present.txt'), {
        path: 'vendor/present.txt',
        mode: '100644',
        oid: presentBlobOid,
        byteLength: Buffer.byteLength('carried-present\n'),
      });

      const sourceEntriesMissing = new Map([
        ['vendor/keep.txt', { mode: '100644', type: 'blob', oid: 'a'.repeat(40) }],
        ['vendor/missing.txt', { mode: '100644', type: 'blob', oid: missingBlobOid }],
      ]);
      const missingDelta = computeAllowedSourceRevisionCarryDelta(snapshotContext, baseEntries, sourceEntriesMissing);
      assert.deepEqual(missingDelta.carryUpdates, [
        { path: 'vendor/missing.txt', mode: '100644', oid: missingBlobOid },
      ]);

      await assert.rejects(
        () => applyCarryDeltaToEffectiveBaseline(
          repo,
          new Map(),
          new Map(),
          missingDelta.carryRemovals,
          missingDelta.carryUpdates,
          GIT_TEST_ENV,
        ),
        (err: unknown) => err instanceof GitHubAppError
          && err.code === 'ACTION_INPUT_INVALID'
          && err.message === `failed to read carried baseline blob size for "vendor/missing.txt" (${missingBlobOid})`,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
