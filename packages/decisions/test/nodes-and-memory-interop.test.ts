import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { evaluateCompactionPolicy } from '@loopwright/memory';
import type { Digest } from '@loopwright/core';
import type { CompactionPolicyInput } from '@loopwright/memory';
import type { DecisionRequestBase } from '../src/router.js';
import { DecisionBudgetTracker } from '../src/client.js';
import {
  DECISION_CAPABILITY_JEV_SKILL_CHECKS, assertDecisionAuthorityBoundary, evaluateCycleAlignment,
  evaluateCyclePrechecks, evaluateSoftCompactionAdvisory, heuristicCapabilityTier, routeTaskCapability,
  triageCandidateDiff,
} from '../src/nodes.js';
import { validateDecisionPolicy } from '../src/schema.js';
import type { DecisionPolicyConfig } from '../src/types.js';

function hex(seed: string): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(seed).digest('hex') };
}

function policy(overrides: Partial<Record<string, unknown>> = {}): DecisionPolicyConfig {
  return validateDecisionPolicy({ enabled: true, disclosurePolicy: 'repo-approved-redacted-evidence', ...overrides });
}

function transportFor(payload: () => Record<string, unknown>): import('../src/types.js').DecisionTransport & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async send() {
      calls += 1;
      return { status: 200, body: JSON.stringify(payload()) };
    },
  } as import('../src/types.js').DecisionTransport & { calls: () => number };
}

function base(overrides: Partial<DecisionRequestBase> = {}): DecisionRequestBase {
  return { policy: policy(), state: {}, budget: new DecisionBudgetTracker(), apiKey: 'fixture-decision-key', ...overrides };
}

describe('assertDecisionAuthorityBoundary', () => {
  it('rejects all six non-delegable intents with DECISION_AUTHORITY_VIOLATION', () => {
    for (const intent of ['grant_execution_authority', 'certify_verification_evidence', 'skip_adversarial_review', 'approve_external_gate', 'override_pinned_model', 'veto_hard_compaction']) {
      try {
        assertDecisionAuthorityBoundary(intent);
        assert.fail(`expected violation for ${intent}`);
      } catch (error) {
        assert.equal((error as { code: string }).code, 'DECISION_AUTHORITY_VIOLATION');
        assert.equal((error as { authorityViolation: boolean }).authorityViolation, true);
      }
    }
  });

  it('fails closed on unknown intents and accepts the five node intents', () => {
    for (const intent of ['grant_shell', 'approve_merge', '']) {
      assert.throws(() => assertDecisionAuthorityBoundary(intent), /decision layer/);
    }
    for (const intent of ['route_capability_tier', 'select_skills', 'evaluate_cycle_alignment', 'advise_soft_compaction', 'triage_candidate_diff']) {
      assert.doesNotThrow(() => assertDecisionAuthorityBoundary(intent));
    }
  });
});

describe('routeTaskCapability', () => {
  const task = {
    taskId: 'task.fix-login', taskKind: 'bug-fix-login-flow', estimatedFilesCount: 3,
    hasFailingTests: false, requiresArchitectureChange: false,
    candidateSkills: ['run-tests', 'deploy-service', 'review-diff'],
  };

  it('preserves a pinned tier and role with zero transport calls', async () => {
    const transport = transportFor(() => { throw new Error('must not be called'); });
    const result = await routeTaskCapability({ ...(base({ transport, policy: policy() }) ), task: { ...task, pinnedCapabilityTier: 'strongest', pinnedRole: 'architect' } });
    assert.equal(result.tier, 'strongest');
    assert.equal(result.role, 'architect');
    assert.equal(result.userOverridePreserved, true);
    assert.equal(result.transportCalls, 0);
    assert.equal(result.source, 'user_override');
  });

  it('falls back to deterministic heuristics and keyword matching when Jev is disabled', async () => {
    const result = await routeTaskCapability({
      ...(base({ policy: policy({ enabled: false }) })),
      task: { ...task, candidateSkills: ['login-flow-review', 'run-tests', 'unrelated-thing'] },
    });
    assert.equal(result.tier, 'fast');
    assert.equal(result.source, 'deterministic_fallback');
    assert.equal(result.fallbackReason, 'policy_disabled');
    assert.equal(result.transportCalls, 0);
    assert.deepEqual(result.skills, ['login-flow-review']);
    assert.equal(result.userOverridePreserved, false);
  });

  it('heuristic tiering escalates with failing tests and architecture changes', () => {
    assert.equal(heuristicCapabilityTier({ ...task, estimatedFilesCount: 2, hasFailingTests: true }), 'balanced');
    assert.equal(heuristicCapabilityTier({ ...task, estimatedFilesCount: 30 }), 'strongest');
    assert.equal(heuristicCapabilityTier({ ...task, requiresArchitectureChange: true }), 'strongest');
    assert.equal(heuristicCapabilityTier(task), 'fast');
  });

  it('accepts a high-confidence jev answer and merges deterministic remainder skills', async () => {
    const skills: string[] = ['run-tests', ...Array.from({ length: 150 }, (_, index) => `skill-${index}-area`)];
    const transport = transportFor(() => ({
      answers: {
        'capability-tier': { choice: 'balanced', confidence: 0.92, probabilities: { fast: 0.03, balanced: 0.92, strongest: 0.05 } },
        ...Object.fromEntries(skills.slice(0, DECISION_CAPABILITY_JEV_SKILL_CHECKS).map((skill, index) => [
          `skill:${skill}`, { noul: index < 10 ? 0.95 : 0.05 },
        ])),
      },
      usage: { input_tokens: 500, output_tokens: 100 },
    }));
    const result = await routeTaskCapability({ ...(base({ transport }) ), task: { ...task, candidateSkills: skills } });
    assert.equal(result.tier, 'balanced');
    assert.equal(result.source, 'jev');
    assert.equal(result.transportCalls, 1);
    assert.equal(result.skills.filter(skill => skill.startsWith('skill-')).length, 9);
    assert.ok(result.skills.includes('run-tests'));
  });
});

describe('evaluateCycleAlignment', () => {
  const cycle = {
    contractHash: hex('contract'), expectedContractHash: hex('contract'),
    baseRevision: 'b'.repeat(40), expectedBaseRevision: 'b'.repeat(40),
    leaseEpoch: 'epoch-1', expectedLeaseEpoch: 'epoch-1', leaseExpired: false,
    writableScopeViolations: [],
    remainingBudgetUsd: 5, remainingCycles: 3,
    contextUtilization: 0.42, failedVerificationLoops: 0,
  };

  it('blocks on contract, revision, lease, and hard-compaction pre-check failures with zero calls', async () => {
    const transport = transportFor(() => { throw new Error('must not be called'); });
    for (const broken of [
      { ...cycle, contractHash: hex('other') },
      { ...cycle, baseRevision: 'c'.repeat(40) },
      { ...cycle, leaseEpoch: 'epoch-2' },
      { ...cycle, leaseExpired: true },
      { ...cycle, contextUtilization: 0.85 },
      { ...cycle, failedVerificationLoops: 2 },
    ]) {
      const result = await evaluateCycleAlignment({ ...(base({ transport }) ), cycle: broken });
      assert.equal(result.route, 'blocked');
      assert.equal(result.precheckPassed, false);
      assert.equal(result.transportCalls, 0);
    }
    assert.equal(transport.calls(), 0);
  });

  it('routes scope and budget exhaustion to needs_review', async () => {
    for (const broken of [
      { ...cycle, writableScopeViolations: ['etc/**'] },
      { ...cycle, remainingBudgetUsd: 0 },
      { ...cycle, remainingCycles: 0 },
    ]) {
      const result = await evaluateCycleAlignment({ ...(base() ), cycle: broken });
      assert.equal(result.route, 'needs_review');
      assert.equal(result.precheckPassed, false);
      assert.equal(result.transportCalls, 0);
    }
  });

  it('accepts a high-confidence jev alignment on green pre-checks', async () => {
    const transport = transportFor(() => ({
      answers: { 'cycle-alignment': { choice: 'revise', confidence: 0.9, probabilities: { continue: 0.05, revise: 0.9, needs_review: 0.03, blocked: 0.02 } } },
      usage: { input_tokens: 30, output_tokens: 5 },
    }));
    const result = await evaluateCycleAlignment({ ...(base({ transport }) ), cycle });
    assert.equal(result.route, 'revise');
    assert.equal(result.precheckPassed, true);
    assert.equal(result.source, 'jev');
    assert.equal(result.transportCalls, 1);
  });

  it('continues deterministically when Jev is disabled or answers below the confirm threshold', async () => {
    const disabled = await evaluateCycleAlignment({ ...(base({ policy: policy({ enabled: false }) }) ), cycle });
    assert.equal(disabled.route, 'continue');
    assert.equal(disabled.source, 'deterministic_fallback');
    const marginal = transportFor(() => ({
      answers: { 'cycle-alignment': { choice: 'blocked', confidence: 0.3, probabilities: { continue: 0.3, revise: 0.3, needs_review: 0.2, blocked: 0.2 } } },
    }));
    const low = await evaluateCycleAlignment({ ...(base({ transport: marginal }) ), cycle });
    assert.equal(low.route, 'continue');
    assert.equal(low.fallbackReason, 'low_confidence');
  });

  it('exposes the pre-checks for deterministic callers', () => {
    assert.deepEqual(evaluateCyclePrechecks(cycle), { passed: true, route: null });
    assert.deepEqual(evaluateCyclePrechecks({ ...cycle, contractHash: hex('nope') }), { passed: false, route: 'blocked' });
  });
});

describe('evaluateSoftCompactionAdvisory', () => {
  function compactionInput(advisoryDecision: 'compact' | 'defer' | null, overrides: Partial<CompactionPolicyInput> = {}): CompactionPolicyInput {
    return {
      contextWindowTokens: 1000, nextRequestInputTokens: 400, toolResultReserveTokens: 200, maxOutputTokens: 100,
      postCompactionEstimatedTokens: 300, currentContextTokens: 500, softUtilizationThreshold: 0.8,
      recentRepeatFailureCount: 0, repeatFailureThreshold: 2, upcomingExternalWaitMs: 0, externalWaitThresholdMs: 5000,
      externalReceiptsPersisted: false, expectedReplaySavingsTokens: 900, summaryCostTokens: 100, cacheRebuildCostTokens: 100,
      unpairedToolCallIds: [], sessionMemorySnapshotDigest: hex('snapshot'), activeMemorySnapshotDigest: hex('snapshot'),
      checkpointId: 'checkpoint.one', pendingOperationIds: ['op.one'], advisoryDecision, ...overrides,
    };
  }

  it('forces the compact advisory with the veto refused on hard triggers and zero transport calls', async () => {
    const transport = transportFor(() => { throw new Error('must not be called'); });
    for (const compaction of [{ contextUtilization: 0.85, failedVerificationLoops: 0 }, { contextUtilization: 0.5, failedVerificationLoops: 2 }]) {
      const result = await evaluateSoftCompactionAdvisory({ ...(base({ transport }) ), compaction });
      assert.equal(result.advisoryDecision, 'compact');
      assert.equal(result.hardTriggerActive, true);
      assert.equal(result.hardTriggerVetoRefused, true);
      assert.equal(result.transportCalls, 0);
    }
    assert.equal(transport.calls(), 0);
  });

  it('advises defer by default in the soft zone and null below it', async () => {
    const softDisabled = await evaluateSoftCompactionAdvisory({ ...(base({ policy: policy({ enabled: false }) }) ), compaction: { contextUtilization: 0.7, failedVerificationLoops: 0 } });
    assert.equal(softDisabled.advisoryDecision, 'defer');
    const softAccepted = transportFor(() => ({
      answers: { 'soft-compaction': { choice: 'compact', confidence: 0.95, probabilities: { compact: 0.95, defer: 0.05 } } },
    }));
    const accepted = await evaluateSoftCompactionAdvisory({ ...(base({ transport: softAccepted }) ), compaction: { contextUtilization: 0.7, failedVerificationLoops: 0 } });
    assert.equal(accepted.advisoryDecision, 'compact');
    assert.equal(accepted.source, 'jev');
    const below = await evaluateSoftCompactionAdvisory({ ...(base() ), compaction: { contextUtilization: 0.42, failedVerificationLoops: 0 } });
    assert.equal(below.advisoryDecision, null);
    assert.equal(below.transportCalls, 0);
  });

  it('interoperates with @loopwright/memory: the advisory never vetoes a hard compaction', async () => {
    const hardTrigger = await evaluateSoftCompactionAdvisory({ ...(base() ), compaction: { contextUtilization: 0.9, failedVerificationLoops: 0 } });
    assert.equal(hardTrigger.advisoryDecision, 'compact');
    const memoryHard = evaluateCompactionPolicy(compactionInput('defer', {
      nextRequestInputTokens: 900,
    }));
    assert.equal(memoryHard.disposition, 'compact_now');
    assert.equal(memoryHard.layer, 'hard');
    assert.equal(memoryHard.vetoable, false);
  });

  it('interoperates with @loopwright/memory: a soft defer advice vetoes soft compaction', async () => {
    const softAdvice = await evaluateSoftCompactionAdvisory({
      ...(base({ policy: policy({ enabled: false }) })),
      compaction: { contextUtilization: 0.7, failedVerificationLoops: 0 },
    });
    assert.equal(softAdvice.advisoryDecision, 'defer');
    const memorySoft = evaluateCompactionPolicy(compactionInput(softAdvice.advisoryDecision, {
      currentContextTokens: 700, softUtilizationThreshold: 0.6,
    }));
    assert.equal(memorySoft.disposition, 'defer');
    assert.equal(memorySoft.layer, 'soft');
    assert.equal(memorySoft.vetoable, true);
    const memoryCompact = evaluateCompactionPolicy(compactionInput('compact', { currentContextTokens: 700, softUtilizationThreshold: 0.6 }));
    assert.equal(memoryCompact.disposition, 'compact_now');
    assert.equal(memoryCompact.layer, 'soft');
  });
});

describe('triageCandidateDiff', () => {
  const diff = {
    summary: {
      changedFiles: ['services/auth/login.ts'], addedLines: 40, deletedLines: 8,
      touchedPackages: ['services/auth'], redactedHunkSummaries: ['replaced session token validation in auth'],
    },
    rules: [
      { id: 'authz', description: 'auth session token validation changed', severity: 'blocking', kind: 'noul', threshold: 0.6 },
      { id: 'style', description: 'unrelated frontend styling drift', severity: 'nit', kind: 'noul' },
      { id: 'risk', description: 'risk of regression in auth flows', severity: 'important', kind: 'score' },
    ] as const,
  };

  it('escalates high-confidence rules above their thresholds in one batched call', async () => {
    const transport = transportFor(() => ({
      answers: {
        'rule:authz': { noul: 0.95 },
        'rule:style': { noul: 0.2 },
        'rule:risk': { score: 0, confidence: 0.9, probabilities: [1, 0, 0] },
      },
      usage: { input_tokens: 60, output_tokens: 10 },
    }));
    const result = await triageCandidateDiff({ ...(base({ transport }) ), diff });
    assert.equal(result.transportCalls, 1);
    assert.equal(result.verificationCertified, false);
    const escalated = result.escalated.map(entry => entry.ruleId);
    assert.deepEqual(escalated, ['authz']);
    const entry = result.escalated[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.source, 'jev');
    assert.equal(entry.advisoryOnly, true);
  });

  it('falls back to deterministic static matching when Jev is disabled and never certifies', async () => {
    const result = await triageCandidateDiff({ ...(base({ policy: policy({ enabled: false }) }) ), diff });
    assert.equal(result.verificationCertified, false);
    assert.equal(result.source, 'deterministic_fallback');
    assert.deepEqual(result.escalated.map(entry => entry.ruleId), ['authz', 'risk']);
    for (const entry of result.escalated) {
      assert.equal(entry.source, 'deterministic_heuristic');
      assert.equal(entry.advisoryOnly, true);
    }
  });

  it('rejects empty rule batches', async () => {
    await assert.rejects(
      () => triageCandidateDiff({ ...(base() ), diff: { ...diff, rules: [] } }),
      (error: { code: string }) => error.code === 'DECISION_BATCH_SIZE_INVALID',
    );
  });
});
