import { createHash } from 'node:crypto';
import { admitTask, bindSubject, constructRunResult, digestArtifact, type ArtifactManifest, type Digest, type Evidence, type ResolvedArtifact, type RunResult, type RunStatus, type TaskContract, type TaskLock } from '@loopwright/core';

export const BASE_REVISION = 'b'.repeat(40);
export const SOURCE_REVISION = 'c'.repeat(40);
export const CONTRACT: TaskContract = {
  apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract',
  spec: {
    goal: 'demo goal', taskpack: 'demo',
    target: { repository: 'org/repo', baseRevision: BASE_REVISION, sourceRevision: SOURCE_REVISION, matrix: null },
    scope: { writable: ['src/**'], protected: [] },
    roles: [{ id: 'coder', adapter: 'pi', provider: 'prov', model: 'model', thinking: 'off', tools: [] }],
    trustedContext: { revision: 'rev.one', discovery: 'disabled', resources: [] },
    budgets: { wallTimeMs: 60000, totalTokens: 10000, perCallOutputTokens: 2000, maxModelCalls: 10, maxConcurrency: 2,
      maxFormatRepairs: 2, maxImplementationRepairs: 3, maxTransportRetries: 3,
      enforcement: { wallTime: 'soft_accounting', tokens: 'soft_accounting', modelCalls: 'soft_accounting', concurrency: 'soft_accounting',
        formatRepairs: 'soft_accounting', implementationRepairs: 'soft_accounting', transportRetries: 'soft_accounting' } },
    steps: [{ id: 'work', kind: 'agent', uses: 'work', roleId: 'coder', dependsOn: [] }],
    acceptance: { required: ['check.one'], checks: [{ id: 'check.one', allowedEvidenceLevels: ['local_execution'] }] },
  },
};
export function hex(seed: string): Digest { return { algorithm: 'sha256', hex: createHash('sha256').update(seed).digest('hex') }; }
export function hexText(seed: string): string { return createHash('sha256').update(seed).digest('hex'); }
export function digestOf(content: string): Digest { return hex(content); }
export function artifactOf(name: string, content: string): ResolvedArtifact { return { name, bytes: Buffer.from(content, 'utf8') }; }
export function refOf(artifact: ResolvedArtifact): { name: string; digest: Digest; byteLength: number } {
  const reference = digestArtifact(artifact.name, artifact.bytes);
  if (!reference.ok) throw new Error(JSON.stringify(reference.errors));
  return reference.value;
}
export interface RunFixture {
  readonly lock: TaskLock; readonly result: RunResult; readonly evidence: readonly Evidence[];
  readonly manifest: ArtifactManifest; readonly artifactRefs: readonly { name: string; digest: Digest; byteLength: number }[];
}
export async function buildRun(status: RunStatus, runId = 'run.fixture.one', contract: TaskContract = CONTRACT): Promise<RunFixture> {
  const admitted = admitTask(contract, { admissionId: 'admission.fixture', runId });
  if (!admitted.ok) throw new Error(JSON.stringify(admitted.errors));
  const lock = admitted.value;
  const candidate = artifactOf('candidate.bin', 'candidate-body');
  const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' },
    spec: { entries: [refOf(candidate)] } };
  const bound = bindSubject(lock, manifest);
  if (!bound.ok) throw new Error(JSON.stringify(bound.errors));
  const subject = bound.value;
  const checkId = contract.spec.acceptance.checks[0]!.id;
  const evidenceBytes = artifactOf('evidence-one.bin', `evidence for ${runId} ${status}`);
  const method = status === 'no_change' ? 'verify_no_change' : 'method.check';
  const passed = status === 'completed' || status === 'no_change';
  const observedStatus = passed ? 'passed' : status === 'blocked' ? 'blocked' : 'failed';
  const claimReason = passed ? null : `fixture ${status} failure`;
  const evidence: Evidence = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'Evidence', metadata: { id: 'evidence.check.one' },
    spec: { checkId, observedStatus: observedStatus as Evidence['spec']['observedStatus'], producerId: 'producer.one', method,
      level: 'local_execution', subject, artifacts: [refOf(evidenceBytes)],
      reason: passed ? null : `fixture ${status} observation` } };
  const claims = status === 'cancelled' ? []
    : [{ checkId, status: observedStatus as 'passed' | 'failed' | 'blocked', evidenceId: evidence.metadata.id, reason: claimReason }];
  const artifacts = [candidate, evidenceBytes];
  const built = constructRunResult({ trusted: { expectedLock: lock, candidateManifest: manifest, eligibleEvidence: [evidence], usage: [],
    externalEffects: status === 'reconcile_required' ? 'unknown' : 'none',
    noChange: status === 'no_change' ? { checkId, evidenceId: evidence.metadata.id, reason: 'no_applicable_update' } : null },
    candidate: { status, checks: claims, memory: { status: 'not_requested', reason: null } } }, artifacts);
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return { lock, result: built.value, evidence: [evidence], manifest, artifactRefs: [refOf(candidate), refOf(evidenceBytes)] };
}
export function inventoryMap(fixture: RunFixture): Map<string, { readonly byteLength: number; readonly digest: Digest }> {
  return new Map(fixture.artifactRefs.map(reference => [reference.name, { byteLength: reference.byteLength, digest: reference.digest }]));
}
