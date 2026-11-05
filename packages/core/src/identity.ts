import { createHash } from 'node:crypto';
import { snapshot, type Json } from './boundary.js';
import { contractSchema, digestSchema, document, identifier, nullable, record, repository, revision, type Digest, type Infer, type TaskContract } from './contracts.js';
import { manifestSchema, type ArtifactManifest } from './artifacts.js';
import { attempt, fail, type Result } from './diagnostics.js';

// Only validated, owned values reach this serializer. It never sees caller objects.
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Readonly<Record<string, unknown>>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
export function hashDomain(domain: 'task-contract' | 'task-lock' | 'artifact-manifest' | 'target-matrix', value: unknown): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(`loopwright.dev/${domain}/v1alpha1\0`, 'utf8').update(canonical(value), 'utf8').digest('hex') };
}
const admissionSchema = record({ admissionId: identifier, runId: identifier });
const lockShape = document('TaskLock', record({ runId: identifier, contract: contractSchema, contractHash: digestSchema, lockHash: digestSchema }));
export type TaskLock = Infer<typeof lockShape>;
export function lockSchema(input: Json, path = ''): TaskLock {
  const lock = lockShape(input, path);
  const contractHash = hashDomain('task-contract', lock.spec.contract);
  if (lock.spec.contractHash.hex !== contractHash.hex) fail('HASH_MISMATCH', `${path}/spec/contractHash`);
  const lockHash = hashDomain('task-lock', { admissionId: lock.metadata.id, runId: lock.spec.runId, contractHash });
  if (lock.spec.lockHash.hex !== lockHash.hex) fail('HASH_MISMATCH', `${path}/spec/lockHash`);
  return lock;
}
export function admitTask(input: unknown, admission: unknown): Result<TaskLock> {
  return attempt(() => {
    const contract: TaskContract = contractSchema(snapshot(input));
    const identity = admissionSchema(snapshot(admission), '/admission');
    const contractHash = hashDomain('task-contract', contract);
    return {
      apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskLock', metadata: { id: identity.admissionId },
      spec: { runId: identity.runId, contract, contractHash, lockHash: hashDomain('task-lock', { ...identity, contractHash }) },
    };
  });
}
export function identifyManifest(input: unknown): Result<{ readonly manifest: ArtifactManifest; readonly digest: Digest }> {
  return attempt(() => {
    const manifest = manifestSchema(snapshot(input));
    return { manifest, digest: hashDomain('artifact-manifest', manifest) };
  });
}
export const subjectSchema = record({ lockHash: digestSchema, contractHash: digestSchema, repository,
  baseRevision: revision, sourceRevision: revision, candidateDigest: digestSchema, targetMatrixDigest: nullable(digestSchema) });
export type Subject = Infer<typeof subjectSchema>;
export function deriveSubject(lock: TaskLock, manifest: ArtifactManifest): Subject {
  const target = lock.spec.contract.spec.target;
  return {
    // Copies keep the public JSON-tree domain free of shared aliases.
    lockHash: { ...lock.spec.lockHash }, contractHash: { ...lock.spec.contractHash },
    repository: target.repository, baseRevision: target.baseRevision, sourceRevision: target.sourceRevision,
    candidateDigest: hashDomain('artifact-manifest', manifest),
    targetMatrixDigest: target.matrix === null ? null : hashDomain('target-matrix', target.matrix),
  };
}
export function bindSubject(expectedLock: unknown, candidateManifest: unknown): Result<Subject> {
  return attempt(() => deriveSubject(lockSchema(snapshot(expectedLock)), manifestSchema(snapshot(candidateManifest))));
}
export function matchSubject(expected: Subject, observed: Subject, path: string, checkId: string | null = null): void {
  for (const field of ['lockHash', 'contractHash', 'repository', 'baseRevision', 'sourceRevision', 'candidateDigest', 'targetMatrixDigest'] as const) {
    if (canonical(expected[field]) !== canonical(observed[field])) fail('IDENTITY_MISMATCH', `${path}/${field}`, checkId);
  }
}
