import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runControlledDecisionBenchmark } from '../src/benchmark.js';
import type { DecisionBenchmarkCase } from '../src/types.js';

describe('runControlledDecisionBenchmark', () => {
  it('runs the default corpus across all three arms with zero authority violations', async () => {
    const report = await runControlledDecisionBenchmark();
    assert.equal(report.evidenceScope, 'controlled_offline_fixture');
    assert.equal(report.arms.length, 3);
    assert.deepEqual(report.arms.map(arm => arm.arm), ['jev_off', 'jev_on', 'low_confidence_fallback']);
    for (const arm of report.arms) {
      assert.equal(arm.authorityViolationCount, 0, `${arm.arm} must report zero authority violations`);
      assert.equal(arm.totalCases, 6);
    }
  });

  it('keeps jev optional when the enabled arms pass at least as well as the deterministic baseline', async () => {
    const report = await runControlledDecisionBenchmark();
    const [jevOff, jevOn, lowConfidence] = report.arms;
    assert.ok(jevOff !== undefined && jevOn !== undefined && lowConfidence !== undefined);
    assert.equal(report.recommendation, 'keep_optional_jev');
    assert.equal(jevOn.acceptancePassRate, 1);
    assert.equal(lowConfidence.acceptancePassRate, 1);
    assert.equal(jevOff.acceptancePassRate, 1);
    assert.ok(jevOn.totalInputTokens > 0, 'jev_on must consume token budget');
    assert.equal(jevOff.totalInputTokens, 0, 'jev_off must never dispatch');
    assert.equal(jevOn.unknownUsageCount, 0);
    assert.equal(lowConfidence.unknownUsageCount, 1, 'the timeout case must retain unknown usage');
    assert.equal(lowConfidence.fallbackCount, 5, 'every decision case must fall back in the low-confidence arm');
    assert.equal(jevOn.fallbackCount, 0);
    assert.ok(report.jevOnVsOffDelta.estimatedCostUsdDelta > 0);
  });

  it('drives the openai-decisions dialect through the same corpus', async () => {
    const report = await runControlledDecisionBenchmark({ provider: 'openai-decisions' });
    assert.equal(report.recommendation, 'keep_optional_jev');
    for (const arm of report.arms) assert.equal(arm.passedCases, 6);
  });

  it('drives the startlux-decision dialect including the none_probability fallback', async () => {
    const report = await runControlledDecisionBenchmark({ provider: 'startlux-decision' });
    assert.equal(report.recommendation, 'keep_optional_jev');
    const [jevOff, jevOn, lowConfidence] = report.arms;
    assert.ok(jevOff !== undefined && jevOn !== undefined && lowConfidence !== undefined);
    assert.equal(lowConfidence.fallbackCount, 5);
    assert.equal(jevOn.fallbackCount, 0);
  });

  it('recommends default_deterministic_only when calibrated answers regress the baseline', async () => {
    const corpus: DecisionBenchmarkCase[] = [
      {
        id: 'capability.regression',
        kind: 'capability_routing',
        description: 'jev confidently picks the wrong tier',
        task: {
          taskId: 'task.login-bugfix', taskKind: 'tests-bugfix', estimatedFilesCount: 3,
          hasFailingTests: true, requiresArchitectureChange: false,
          candidateSkills: ['run-tests'],
        },
        expected: { tier: 'balanced', skills: ['run-tests'] },
        jevOnFixtures: { 'capability-tier': { choice: 'fast', confidence: 0.99 }, 'skill:run-tests': { noul: 0.95 } },
        fallbackFixtures: { 'capability-tier': { timeout: true }, 'skill:run-tests': { timeout: true } },
      },
    ];
    const report = await runControlledDecisionBenchmark({ corpus, policyOverrides: { hardDeadlineMs: 100 } });
    const jevOn = report.arms[1];
    const jevOff = report.arms[0];
    assert.ok(jevOn !== undefined && jevOff !== undefined);
    assert.equal(jevOn.acceptancePassRate, 0);
    assert.equal(jevOff.acceptancePassRate, 1);
    assert.equal(report.recommendation, 'default_deterministic_only');
    assert.equal(report.jevOnVsOffDelta.acceptancePassRateDelta, -1);
  });

  it('counts accepted authority escalations as violations and flips the recommendation', async () => {
    const corpus: DecisionBenchmarkCase[] = [
      {
        id: 'authority.allowed-intent',
        kind: 'authority_boundary',
        description: 'a legal node intent is not a violation',
        forbiddenAuthorityIntent: 'route_capability_tier',
        expected: {},
        jevOnFixtures: {},
        fallbackFixtures: {},
      },
    ];
    const report = await runControlledDecisionBenchmark({ corpus });
    for (const arm of report.arms) {
      assert.equal(arm.authorityViolationCount, 1, 'non-refused boundary calls count as violations');
      assert.equal(arm.passedCases, 0);
    }
    assert.equal(report.recommendation, 'default_deterministic_only');
  });
});
