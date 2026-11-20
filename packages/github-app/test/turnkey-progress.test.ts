import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatHostSessionProgressLog, SecretScrubber } from '../src/index.js';

describe('turnkey progress observability formatting and secret scrubbing', () => {
  it('formats cumulative tokens vs budget, scrubbed tool summaries, and circuit breaker events', () => {
    const scrubber = new SecretScrubber();
    scrubber.register('sk_live_progress_secret_9988');

    const settledLine = formatHostSessionProgressLog(
      {
        kind: 'request_settled',
        turn: 3,
        stopReason: 'toolUse',
        inputTokens: 24_000,
        outputTokens: 450,
        elapsedMs: 12_000,
        toolCallNames: ['bash'],
      },
      { cumulativeTokens: 128_000, totalTokenBudget: 20_000_000 },
    );
    assert.equal(settledLine, 'turn #3: settled in 12s — in 24K / out 450 (cum 128K/20M), tools=[bash]');

    const bashLine = formatHostSessionProgressLog(
      {
        kind: 'tool_end',
        name: 'bash',
        isError: false,
        elapsedMs: 2_100,
        summary: 'go test ./pkg/worker/... sk_live_progress_secret_9988',
      },
      { cumulativeTokens: 0, totalTokenBudget: 20_000_000 },
    );
    assert.ok(bashLine !== null);
    const scrubbedBash = scrubber.scrub(bashLine);
    assert.equal(scrubbedBash.includes('sk_live_progress_secret_9988'), false);
    assert.match(scrubbedBash, /^tool bash \(go test \.\/pkg\/worker\/\.\.\. \[scrubbed\]\): ok \(2\.1s\)$/);

    const writeLine = formatHostSessionProgressLog(
      {
        kind: 'tool_end',
        name: 'write',
        isError: false,
        elapsedMs: 120,
        summary: '.auto-sync/proposals/kv-transfer.json',
      },
      { cumulativeTokens: 0, totalTokenBudget: 20_000_000 },
    );
    assert.equal(writeLine, 'tool write (.auto-sync/proposals/kv-transfer.json): ok (120ms)');

    const breakerLine = formatHostSessionProgressLog(
      {
        kind: 'circuit_breaker',
        reason: 'max_turns',
        turn: 20,
        message: 'circuit breaker: stopped after 20 turns (limit=20, repair=implementation)',
      },
      { cumulativeTokens: 0, totalTokenBudget: 20_000_000 },
    );
    assert.equal(breakerLine, 'circuit breaker: stopped after 20 turns (limit=20, repair=implementation)');
  });
});
