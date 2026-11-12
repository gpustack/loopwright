import assert from 'node:assert/strict';
import type { Result } from '../src/index.js';
import { admitTask, bindSubject, digestArtifact } from '../src/index.js';

export function value<T>(result: Result<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('expected success');
  return result.value;
}
export function code(result: Result<unknown>): string {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('expected rejection');
  return result.errors[0]!.code;
}
export function contract() {
  return {
    apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract',
    spec: {
      goal: 'Update the pinned package', taskpack: 'package-update',
      target: { repository: 'team/repository', baseRevision: 'base-1', sourceRevision: 'source-1', matrix: null as null | { id: string; platform: string; variant: string }[] },
      scope: { writable: ['packages/**'], protected: ['packages/policy/**'] },
      roles: [{ id: 'builder', adapter: 'pi', provider: 'github-copilot', model: 'exact-model', thinking: 'high', tools: ['read', 'mcp__probe__allowed'] }],
      trustedContext: { revision: 'context-1', discovery: 'disabled', resources: [] },
      budgets: { wallTimeMs: 1_000, totalTokens: 1_000, perCallOutputTokens: 100,
        maxModelCalls: 10, maxConcurrency: 2, maxFormatRepairs: 0, maxImplementationRepairs: 2, maxTransportRetries: 1,
        enforcement: { wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission', formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission' } },
      steps: [{ id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder' as string | null, dependsOn: [] as string[] }],
      acceptance: { required: ['tests'], checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }] },
    },
  };
}

export function evaluationFixture(task = contract(), checkId = 'tests') {
  const expectedLock = value(admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }));
  const candidateBytes = Buffer.from('candidate patch\n'), logBytes = Buffer.from('test output: pass\n');
  const candidateManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' },
    spec: { entries: [value(digestArtifact('candidate.patch', candidateBytes))] } };
  const subject = value(bindSubject(expectedLock, candidateManifest));
  const evidence = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'observation-1' }, spec: {
    checkId, observedStatus: 'passed', producerId: 'host-verifier', method: 'node-test', level: 'local_execution',
    subject: structuredClone(subject), artifacts: [value(digestArtifact('test.log', logBytes))], reason: null as string | null,
  } };
  return { input: { trusted: { expectedLock, candidateManifest, eligibleEvidence: [evidence] },
    claims: [{ checkId, status: 'passed', evidenceId: 'observation-1' as string | null, reason: null as string | null }] },
  artifacts: [{ name: 'candidate.patch', bytes: candidateBytes }, { name: 'test.log', bytes: logBytes }] };
}
