import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { DecisionBudgetTracker, DecisionClient, HttpDecisionTransport, JevDecisionClient, createSdkDecisionTransport } from '../src/client.js';
import { sanitizeDecisionState, validateDecisionImages } from '../src/redaction.js';
import { validateDecisionPolicy, validateDecisionQuestions } from '../src/schema.js';
import type { DecisionImageAsset, DecisionPolicyConfig, DecisionQuestion, DecisionSdkRequest, DecisionTransport } from '../src/types.js';

function throwsCode(run: () => unknown, code: string): void {
  try {
    run();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
  }
}

const ENV_NAMES = ['TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'STARTLUX_API_KEY', 'MICROSOFT_DECISION_API_KEY', 'AZURE_API_KEY', 'PERPLEXITY_API_KEY', 'CLOUDFLARE_API_TOKEN', 'LIQUID_API_KEY'];
const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const name of ENV_NAMES) {
    const saved = savedEnv.get(name);
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
    savedEnv.delete(name);
  }
});

function useEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

function policy(overrides: Partial<Record<string, unknown>> = {}): DecisionPolicyConfig {
  return validateDecisionPolicy({ enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence', ...overrides });
}

function questions(): readonly DecisionQuestion[] {
  return validateDecisionQuestions([{ type: 'choice', id: 'tier', prompt: 'Tier?', options: { fast: 'Fast', balanced: 'Balanced', strongest: 'Strongest' } }]);
}

const keyedResponse = (): Record<string, unknown> => ({
  model: 'jev-latest',
  answers: { tier: { choice: 'balanced', confidence: 0.9, probabilities: { fast: 0.1, balanced: 0.6, strongest: 0.3 } } },
  usage: { input_tokens: 25, output_tokens: 4 },
});

function countingTransport(response: () => Promise<Record<string, unknown>> | Record<string, unknown>): DecisionTransport & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async send() {
      calls += 1;
      const payload = await response();
      return { status: 200, body: JSON.stringify(payload) };
    },
  } as DecisionTransport & { calls: () => number };
}

describe('DecisionBudgetTracker', () => {
  it('settles exact reported usage and prices the snapshot with the spec defaults', () => {
    const budget = new DecisionBudgetTracker();
    budget.reserve(100);
    budget.settle({ input_tokens: 90, output_tokens: 10 });
    const snapshot = budget.snapshot();
    assert.deepEqual(snapshot, {
      totalInputTokens: 90, totalOutputTokens: 10, unknownUsageCount: 0, unknownUsageRetained: false,
      estimatedCostUsd: (90 * 0.042) / 1e6,
    });
  });

  it('refuses pre-send when the token or cost budget is insufficient', () => {
    const tokenBudget = new DecisionBudgetTracker({ maxInputTokens: 100 });
    tokenBudget.reserve(60);
    throwsCode(() => tokenBudget.reserve(41), 'DECISION_BUDGET_EXCEEDED');
    const costBudget = new DecisionBudgetTracker({ maxCostUsd: 0.000001 });
    throwsCode(() => costBudget.reserve(1_000_000), 'DECISION_BUDGET_EXCEEDED');
  });

  it('retains the reservation on unknown post-dispatch usage and never refunds it', () => {
    const budget = new DecisionBudgetTracker({ maxInputTokens: 100 });
    budget.reserve(50);
    budget.retainUnknown(50);
    const snapshot = budget.snapshot();
    assert.equal(snapshot.totalInputTokens, 50);
    assert.equal(snapshot.unknownUsageCount, 1);
    assert.equal(snapshot.unknownUsageRetained, true);
    assert.equal(budget.unknownUsageCount, 1);
    throwsCode(() => budget.reserve(60), 'DECISION_BUDGET_EXCEEDED');
  });

  it('releases settled reservations from the committed pool', () => {
    const budget = new DecisionBudgetTracker({ maxInputTokens: 120 });
    budget.reserve(100);
    budget.settle({ input_tokens: 60, output_tokens: 0 });
    budget.reserve(19);
    budget.settle({ input_tokens: 59, output_tokens: 1 });
    assert.equal(budget.committedInputTokens, 119);
    throwsCode(() => budget.reserve(2), 'DECISION_BUDGET_EXCEEDED');
  });

  it('rejects malformed ledger options', () => {
    throwsCode(() => new DecisionBudgetTracker({ maxInputTokens: 0 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => new DecisionBudgetTracker({ maxCostUsd: -1 }), 'DECISION_POLICY_INVALID');
    throwsCode(() => new DecisionBudgetTracker({ inputCostPerMtokUsd: Number.NaN }), 'DECISION_POLICY_INVALID');
  });
});

describe('DecisionClient', () => {
  it('requires a transport or sdk adapter and rejects maxAttempts above 2', () => {
    throwsCode(() => new DecisionClient({ policy: policy() } as never), 'DECISION_POLICY_INVALID');
    throwsCode(() => new DecisionClient({
      policy: policy({ maxAttempts: 3 } as never), transport: countingTransport(keyedResponse),
    }), 'DECISION_POLICY_INVALID');
    assert.equal(JevDecisionClient, DecisionClient);
  });

  it('refuses pre-send without an API key and never invokes the transport', async () => {
    useEnv('TYPESAFE_API_KEY', undefined);
    const transport = countingTransport(() => keyedResponse());
    const client = new DecisionClient({ policy: policy(), transport });
    const budget = new DecisionBudgetTracker();
    await assert.rejects(
      () => client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget }),
      (error: { code: string }) => error.code === 'DECISION_TRANSPORT_ERROR',
    );
    assert.equal(transport.calls(), 0);
    assert.equal(budget.snapshot().totalInputTokens, 0);
  });

  it('resolves per-provider API keys from the environment and settles exact usage', async () => {
    useEnv('MICROSOFT_DECISION_API_KEY', 'ms-key');
    const transport = countingTransport(() => ({
      answers: { tier: { choice: 'balanced', confidence: 0.9, probabilities: { fast: 0.1, balanced: 0.6, strongest: 0.3 } } },
      usage: { input_tokens: 30, output_tokens: 5 },
    }));
    const client = new DecisionClient({ policy: policy({ provider: 'microsoft-decision' }), transport });
    const budget = new DecisionBudgetTracker();
    const result = await client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget });
    assert.equal(result.attempts, 1);
    const snapshot = budget.snapshot();
    assert.equal(snapshot.totalInputTokens, 30);
    assert.equal(snapshot.totalOutputTokens, 5);
    assert.equal(snapshot.unknownUsageRetained, false);
  });

  it('aborts a hanging transport at the hard deadline, retains usage, and routes DECISION_DEADLINE_EXCEEDED', async () => {
    useEnv('TYPESAFE_API_KEY', 'key');
    const hanging: DecisionTransport = {
      send: () => new Promise(() => { /* never resolves */ }),
    };
    const client = new DecisionClient({ policy: policy({ hardDeadlineMs: 100 }), transport: hanging });
    const budget = new DecisionBudgetTracker();
    await assert.rejects(
      () => client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget }),
      (error: { code: string }) => error.code === 'DECISION_DEADLINE_EXCEEDED',
    );
    const snapshot = budget.snapshot();
    assert.equal(snapshot.unknownUsageCount, 1);
    assert.equal(snapshot.unknownUsageRetained, true);
    assert.ok(snapshot.totalInputTokens > 0);
  });

  it('never retries post-dispatch HTTP failures even with maxAttempts 2', async () => {
    useEnv('TYPESAFE_API_KEY', 'key');
    let calls = 0;
    const transport: DecisionTransport = {
      async send() {
        calls += 1;
        return { status: 500, body: 'boom' };
      },
    };
    const client = new DecisionClient({ policy: policy({ maxAttempts: 2 }), transport });
    const budget = new DecisionBudgetTracker();
    await assert.rejects(
      () => client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget }),
      (error: { code: string }) => error.code === 'DECISION_TRANSPORT_ERROR',
    );
    assert.equal(calls, 1);
    assert.equal(budget.snapshot().unknownUsageCount, 1);
  });

  it('retries once on transient pre-dispatch failure inside the same deadline window', async () => {
    useEnv('TYPESAFE_API_KEY', 'key');
    let calls = 0;
    const transport: DecisionTransport = {
      async send() {
        calls += 1;
        if (calls === 1) throw new Error('connection reset');
        return { status: 200, body: JSON.stringify(keyedResponse()) };
      },
    };
    const client = new DecisionClient({ policy: policy({ maxAttempts: 2, hardDeadlineMs: 2_000 }), transport });
    const budget = new DecisionBudgetTracker();
    const result = await client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget });
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(budget.snapshot().unknownUsageCount, 0);
  });

  it('denies a retry when less than 50ms of wall clock remain in the deadline window', async () => {
    useEnv('TYPESAFE_API_KEY', 'key');
    let calls = 0;
    const transport: DecisionTransport = {
      async send() {
        calls += 1;
        await sleep(80);
        throw new Error('connection reset');
      },
    };
    const client = new DecisionClient({ policy: policy({ maxAttempts: 2, hardDeadlineMs: 120 }), transport });
    const budget = new DecisionBudgetTracker();
    await assert.rejects(
      () => client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget }),
      (error: { code: string }) => error.code === 'DECISION_TRANSPORT_ERROR',
    );
    assert.equal(calls, 1);
    assert.equal(budget.snapshot().unknownUsageCount, 1);
  });

  it('fails closed without retry on invalid provider payloads', async () => {
    useEnv('TYPESAFE_API_KEY', 'key');
    const transport = countingTransport(() => ({ answers: {} }));
    const client = new DecisionClient({ policy: policy({ maxAttempts: 2 }), transport });
    const budget = new DecisionBudgetTracker();
    await assert.rejects(
      () => client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget }),
      (error: { code: string }) => error.code === 'DECISION_RESPONSE_INVALID',
    );
    assert.equal(transport.calls(), 1);
    assert.equal(budget.snapshot().unknownUsageCount, 1);
  });

  it('runs an sdk adapter without an HTTP apiKey and preserves all client guarantees', async () => {
    useEnv('TYPESAFE_API_KEY', undefined);
    const requests: DecisionSdkRequest[] = [];
    const adapter = {
      async evaluate(request: DecisionSdkRequest): Promise<unknown> {
        requests.push(request);
        return keyedResponse();
      },
    };
    const client = new DecisionClient({ policy: policy(), sdkAdapter: adapter });
    const budget = new DecisionBudgetTracker();
    const stateBody = sanitizeDecisionState({ taskId: 'task.one' }, policy());
    const result = await client.execute({ questions: questions(), stateBody, budget });
    assert.equal(result.attempts, 1);
    assert.ok(result.outputs[0]?.type === 'choice' && result.outputs[0].choice === 'balanced');
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.provider, 'typesafe-jev');
    assert.equal(request.dialect, 'systemone');
    assert.equal(request.model, 'jev-latest');
    assert.deepEqual(request.state, { taskId: 'task.one' });
    assert.equal(request.questions[0]?.id, 'tier');
    assert.ok(typeof request.wirePayload.questions === 'object');
    assert.equal(request.signal.aborted, true);
    assert.equal(budget.snapshot().unknownUsageCount, 0);
    assert.ok(budget.snapshot().totalInputTokens > 0);
  });

  it('supervises sdk adapters with the same outer hard deadline', async () => {
    useEnv('TYPESAFE_API_KEY', undefined);
    const adapter = {
      evaluate(request: DecisionSdkRequest): Promise<never> {
        return new Promise((_, reject) => {
          request.signal.addEventListener('abort', () => reject(new Error('aborted by sdk')));
        });
      },
    };
    const client = new DecisionClient({ policy: policy({ hardDeadlineMs: 100 }), sdkAdapter: adapter });
    const budget = new DecisionBudgetTracker();
    await assert.rejects(
      () => client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ a: 1 }, policy()), budget }),
      (error: { code: string }) => error.code === 'DECISION_DEADLINE_EXCEEDED',
    );
    assert.equal(budget.snapshot().unknownUsageCount, 1);
  });

  it('bridges an sdk adapter through createSdkDecisionTransport', async () => {
    useEnv('TYPESAFE_API_KEY', undefined);
    const seen: DecisionSdkRequest[] = [];
    const adapter = {
      async evaluate(request: DecisionSdkRequest): Promise<unknown> {
        seen.push(request);
        return keyedResponse();
      },
    };
    const transport = createSdkDecisionTransport(adapter, {
      provider: 'typesafe-jev',
      questions: questions(),
      images: [{ id: 'shot', mediaType: 'image/png', data: 'aGVsbG8=' }],
    });
    const client = new DecisionClient({ policy: policy(), transport });
    const result = await client.execute({ questions: questions(), stateBody: sanitizeDecisionState({ taskId: 'task.one' }, policy()), budget: new DecisionBudgetTracker() });
    assert.ok(result.outputs[0]?.type === 'choice');
    assert.equal(seen.length, 1);
    const seenRequest = seen[0];
    assert.ok(seenRequest !== undefined);
    assert.deepEqual(seenRequest.state, { taskId: 'task.one' });
    assert.equal(seenRequest.questions.length, 1);
    assert.equal(seenRequest.questions[0]?.id, 'tier');
    assert.deepEqual(seenRequest.images, [{ id: 'shot', mediaType: 'image/png', data: 'aGVsbG8=' }]);
  });
});

describe('HttpDecisionTransport', () => {
  it('POSTs JSON with bearer authorization and custom headers to the endpoint', async () => {
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const seen = {
          method: request.method,
          url: request.url,
          authorization: request.headers['authorization'],
          contentType: request.headers['content-type'],
          dangerZone: request.headers['typesafe-danger-zone-images'],
          body: JSON.parse(body) as Record<string, unknown>,
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ seen }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      const transport = new HttpDecisionTransport();
      const response = await transport.send({
        endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
        apiKey: 'secret-key',
        body: JSON.stringify({ model: 'jev-latest', state: { a: 1 } }),
        signal: new AbortController().signal,
        headers: { 'TypeSafe-Danger-Zone-Images': 'true' },
      });
      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body) as { seen: Record<string, unknown> };
      assert.equal(payload.seen.method, 'POST');
      assert.equal(payload.seen.authorization, 'Bearer secret-key');
      assert.equal(payload.seen.contentType, 'application/json');
      assert.equal(payload.seen.dangerZone, 'true');
      assert.deepEqual(payload.seen.body, { model: 'jev-latest', state: { a: 1 } });
    } finally {
      server.close();
    }
  });

  it('surfaces non-2xx statuses for the client to classify', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(503);
      response.end('unavailable');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address !== null && typeof address === 'object');
      const transport = new HttpDecisionTransport();
      const response = await transport.send({
        endpoint: `http://127.0.0.1:${address.port}/`,
        apiKey: 'secret-key',
        body: '{}',
        signal: new AbortController().signal,
      });
      assert.equal(response.status, 503);
      assert.equal(response.body, 'unavailable');
    } finally {
      server.close();
    }
  });
});

describe('image-capable client dispatch', () => {
  it('passes validated images through formatProviderRequest to the adapter', async () => {
    useEnv('TYPESAFE_API_KEY', undefined);
    const images: readonly DecisionImageAsset[] = validateDecisionImages(
      [{ id: 'shot', mediaType: 'image/png', data: Buffer.from('pngbytes').toString('base64') }],
      policy({ allowImages: true }),
    );
    const seen: DecisionSdkRequest[] = [];
    const adapter = {
      async evaluate(request: DecisionSdkRequest): Promise<unknown> {
        seen.push(request);
        return keyedResponse();
      },
    };
    const client = new DecisionClient({ policy: policy({ allowImages: true }), sdkAdapter: adapter });
    const result = await client.execute({
      questions: questions(),
      stateBody: sanitizeDecisionState({ a: 1 }, policy({ allowImages: true })),
      budget: new DecisionBudgetTracker(),
      images,
    });
    assert.ok(result.outputs[0]?.type === 'choice');
    const seenRequest = seen[0];
    assert.ok(seenRequest !== undefined);
    const assets = seenRequest.wirePayload['assets'] as Record<string, { media_type: string }>;
    const shot = assets['shot'];
    assert.ok(shot !== undefined);
    assert.equal(shot.media_type, 'image/png');
    assert.deepEqual(seenRequest.images, images);
    assert.equal(seenRequest.headers['TypeSafe-Danger-Zone-Images'], 'true');
  });
});
