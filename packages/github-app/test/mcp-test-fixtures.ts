import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export async function startHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(err => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('expected TCP server address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>(resolvePromise => server.close(() => resolvePromise())),
  };
}

export function parseGithubOutputs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    const heredoc = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const key = heredoc[1]!;
      const marker = heredoc[2]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i] !== marker) {
        body.push(lines[i]!);
        i += 1;
      }
      out[key] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) {
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return out;
}

export function sseToolCalls(
  model: string,
  turnId: string,
  calls: readonly { readonly id: string; readonly name: string; readonly args: Record<string, unknown> }[],
  usage = { prompt_tokens: 4000, completion_tokens: 500 },
  extraPaddingChunks = 0,
): string {
  const lines: string[] = [];
  for (let i = 0; i < extraPaddingChunks; i += 1) {
    lines.push(
      `data: ${JSON.stringify({
        id: `chatcmpl-${turnId}`,
        model,
        choices: [{ index: 0, delta: { role: i === 0 ? 'assistant' : undefined, reasoning_content: 'x' }, finish_reason: null }],
      })}`,
      '',
    );
  }
  lines.push(
    `data: ${JSON.stringify({
      id: `chatcmpl-${turnId}`,
      model,
      choices: [{
        index: 0,
        delta: {
          role: extraPaddingChunks === 0 ? 'assistant' : undefined,
          tool_calls: calls.map((c, index) => ({
            index,
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: null,
      }],
    })}`,
    '',
    `data: ${JSON.stringify({
      id: `chatcmpl-${turnId}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { ...usage, prompt_tokens_details: { cached_tokens: 100 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  );
  return lines.join('\n');
}

export function sseStop(
  model: string,
  text: string,
  usage = { prompt_tokens: 4000, completion_tokens: 500 },
): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-final',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { ...usage, prompt_tokens_details: { cached_tokens: 100 } },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}
