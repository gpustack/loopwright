import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);

export const GIT_TEST_ENV: Readonly<Record<string, string>> = {
  PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    '/usr/bin/git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Bot', '-c', 'user.email=test@example.com', '-C', cwd, ...args],
    { env: GIT_TEST_ENV, encoding: 'utf8', timeout: 15_000 },
  );
  return stdout.trim();
}

export async function gitWithInput(cwd: string, args: readonly string[], input: Buffer | string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test Bot', '-c', 'user.email=test@example.com', '-C', cwd, ...args],
      { env: GIT_TEST_ENV, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString('utf8')}`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8').trim());
    });
    child.stdin.end(input);
  });
}

export function sseToolCall(model: string, id: string, name: string, args: Record<string, unknown>): string {
  return [
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    })}`,
    '',
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

export function sseStop(model: string, text: string): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-final',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 20 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim().length > 0 ? JSON.parse(text) as Record<string, unknown> : {};
}

export async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind mock HTTP server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => await new Promise<void>(resolve => server.close(() => resolve())),
  };
}

export function parseGithubOutputs(raw: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const sep = line.indexOf('<<LOOPWRIGHT_EOF');
    if (sep > 0) {
      const name = line.slice(0, sep);
      const value = lines[i + 1] ?? '';
      result[name] = value;
      i += 2;
    }
  }
  return result;
}

export async function createEndToEndFixture(): Promise<{
  readonly work: string;
  readonly repo: string;
  readonly bareRemote: string;
  readonly runRoot: string;
  readonly baseSha: string;
  readonly verifySecret: string;
  readonly badToken: string;
  readonly goodToken: string;
  readonly githubToken: string;
}> {
  const work = await mkdtemp(join(tmpdir(), 'lw-t5-e2e-'));
  const repo = join(work, 'repo');
  const sharedSkills = join(work, 'shared-skills');
  const bareRemote = join(work, 'remote.git');
  const runRoot = join(work, 'runs');
  await mkdir(runRoot, { recursive: true, mode: 0o700 });
  await chmod(runRoot, 0o700);

  await mkdir(sharedSkills, { recursive: true });
  await writeFile(join(sharedSkills, 'guide.md'), '# Shared Skill\n');

  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);

  await mkdir(join(repo, '.claude'), { recursive: true });
  await symlink('../shared-skills', join(repo, '.claude', 'skills'));

  await mkdir(join(repo, '.auto-sync', 'prompts'), { recursive: true });
  await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
  await mkdir(join(repo, 'pack'), { recursive: true });
  await mkdir(join(repo, 'docs'), { recursive: true });

  await writeFile(join(repo, '.auto-sync', 'prompts', 'instructions.md'), 'Always update pack/proposal.json and docs/status.md.\n');
  await writeFile(join(repo, 'pack', 'dependencies.json'), JSON.stringify({ pinned: true }, null, 2) + '\n');
  await writeFile(join(repo, 'pack', 'proposal.json'), JSON.stringify({ schema_version: 1, version: '1.0.0' }, null, 2) + '\n');
  await writeFile(join(repo, 'docs', 'status.md'), 'initial\n');

  const verifyScript = `#!/usr/bin/env bash
set -euo pipefail
content="$(cat docs/status.md 2>/dev/null || true)"
if [[ "$content" == "verified-ok" ]]; then
  exit 0
fi
pad="$(printf 'x%.0s' $(seq 1 4100))"
echo "verification failure using token \${CHECK_MARKER:-unset}: \${pad}" >&2
exit 1
`;
  const scriptPath = join(repo, '.auto-sync', 'checks', 'verify.sh');
  await writeFile(scriptPath, verifyScript, { mode: 0o755 });
  await chmod(scriptPath, 0o755);

  const baseEnvSecret = 'verify_secret_tok_9876543210';
  const badToken = 'bad_tok_0000000000001';
  const goodToken = 'good_tok_000000000002';
  const githubToken = 'ghp_secret_tok_12345678901234';

  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial commit']);
  const baseSha = await git(repo, ['rev-parse', 'HEAD']);

  await mkdir(bareRemote, { recursive: true });
  await git(bareRemote, ['init', '--bare', '-b', 'main']);
  await git(repo, ['remote', 'add', 'origin', bareRemote]);
  await git(repo, ['push', '-u', 'origin', 'main']);

  return {
    work,
    repo,
    bareRemote,
    runRoot,
    baseSha,
    verifySecret: baseEnvSecret,
    badToken,
    goodToken,
    githubToken,
  };
}

export function writeTaskpackYaml(repo: string, openAiBaseUrl: string): Promise<void> {
  return writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: auto-sync
spec:
  goal:
    candidate: Sync pack/proposal.json and docs/status.md to match upstream release.
    noChange: Verify upstream status matches pack/proposal.json.
  scope:
    writable:
      - 'pack/**'
      - 'docs/**'
    protected:
      - pack/dependencies.json
      - '.claude/**'
  instructions:
    - .auto-sync/prompts/instructions.md
  upstreams:
    - id: engine
      kind: github-release
      source: acme/engine
      watchedPaths:
        - pack
  proposal:
    path: pack/proposal.json
    requiredFields:
      - schema_version
      - version
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
          allowReadOnlyGitHubToken: true
          env:
            - CHECK_MARKER
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/
    titleTemplate: "chore: update synced pack"
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
      baseUrl: ${openAiBaseUrl}/v1
      cost:
        input: 2
        output: 8
  output:
    formats:
      - json
      - github-step-summary
`);
}
