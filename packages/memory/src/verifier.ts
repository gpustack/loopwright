import type { Evidence, VerificationResult } from '@loopwright/core';
import { diagnostic, digestEqual, hasControlCharacter, incidentReferenceDigest, memoryProposalSchema, renderEntryMarkdown } from './schema.js';
import { isMemoryManagedPath, matchScopePattern, memoryDirectoryFor } from './store.js';
import type { MemoryDiagnostic, MemoryGateResult, MemoryGateName, MemoryOperation, MemoryProposal, MemoryVerificationInput, MemoryVerificationReport } from './types.js';

const CREDENTIAL_PATTERNS: readonly { readonly source: RegExp; readonly label: string }[] = [
  { source: /ghp_[A-Za-z0-9]{20,}/, label: 'GitHub user token' },
  { source: /ghs_[A-Za-z0-9]{20,}/, label: 'GitHub server token' },
  { source: /github_pat_[A-Za-z0-9_]{20,}/, label: 'GitHub fine-grained token' },
  { source: /sk-[A-Za-z0-9_-]{20,}/, label: 'API key' },
  { source: /Bearer [A-Za-z0-9._~+/=-]{16,}/, label: 'bearer token' },
  { source: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key' },
  { source: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
];
const INJECTION_PATTERNS: readonly { readonly source: RegExp; readonly label: string }[] = [
  { source: /=== .*? ===/, label: 'sentinel header' },
  { source: /^REQUIRED:/m, label: 'REQUIRED directive' },
  { source: /^NEVER:/m, label: 'NEVER directive' },
  { source: /^SYSTEM:/m, label: 'SYSTEM directive' },
  { source: /<system>|<\/system>/, label: 'system tag' },
  { source: /AGENTS\.override\.md/, label: 'override file reference' },
  { source: /CLAUDE\.md/, label: 'override file reference' },
];
const SETTLED_FACT_STATUSES = ['completed', 'no_change'] as const;
const INCIDENT_CHECK_ID = 'incident';
const INCIDENT_EVIDENCE_ID = 'evidence.incident';

function gate(name: MemoryGateName, diagnostics: readonly MemoryDiagnostic[]): MemoryGateResult {
  return { gate: name, status: diagnostics.length === 0 ? 'passed' : 'failed', diagnostics };
}
function skippedGate(name: MemoryGateName): MemoryGateResult {
  return { gate: name, status: 'failed', diagnostics: [{ code: 'MEMORY_SCHEMA_INVALID', path: '', detail: 'not evaluated: the memory-schema gate failed' }] };
}
function rowsOf(verification: VerificationResult | null): readonly { readonly checkId: string; readonly status: string; readonly evidenceId: string | null }[] {
  if (verification === null) return [];
  return [...verification.spec.required, ...verification.spec.optional];
}
function parsePatchPaths(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('--- ') && !line.startsWith('+++ ')) continue;
    const raw = line.slice(4).trim();
    if (raw === '/dev/null') continue;
    const path = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
    paths.add(path);
  }
  return [...paths];
}
function schemaGate(input: MemoryVerificationInput): { result: MemoryGateResult; proposal: MemoryProposal | null } {
  try { return { result: gate('memory-schema', []), proposal: memoryProposalSchema(input.proposal, '/proposal') }; }
  catch (error) { return { result: gate('memory-schema', [diagnostic(error)]), proposal: null }; }
}
function provenanceGate(input: MemoryVerificationInput, proposal: MemoryProposal): MemoryGateResult {
  const diagnostics: MemoryDiagnostic[] = [];
  const push = (path: string, detail: string) => diagnostics.push({ code: 'MEMORY_PROVENANCE_INVALID', path, detail });
  const contract = input.lock.spec.contract;
  if (proposal.taskpack !== contract.spec.taskpack) push('/proposal/taskpack', 'proposal taskpack does not match the contract');
  if (proposal.repository !== contract.spec.target.repository) push('/proposal/repository', 'proposal repository does not match the contract target');
  if (proposal.runId !== input.lock.spec.runId) push('/proposal/runId', 'proposal runId does not match the settled lock');
  if (proposal.lockHash.hex !== input.lock.spec.lockHash.hex) push('/proposal/lockHash', 'proposal lockHash does not match the settled lock');
  const rows = rowsOf(input.result?.spec.verification ?? null);
  const evidenceById = new Map<string, Evidence>(input.evidence.map(document => [document.metadata.id, document]));
  const expectedCandidate = new Set<string>();
  if (input.candidateDigest !== null) expectedCandidate.add(input.candidateDigest.hex);
  if (input.incident !== null) expectedCandidate.add(incidentReferenceDigest(input.incident).hex);
  const resultStatus = input.result?.spec.status ?? null;
  for (const [index, operation] of proposal.operations.entries()) {
    if (operation.kind !== 'upsert') continue;
    const entry = operation.entry, base = `/proposal/operations/${index}/entry`;
    if (entry.sourceRef.runId !== proposal.runId) push(`${base}/sourceRef/runId`, 'source runId does not match the proposal');
    if (entry.sourceRef.lockHash.hex !== proposal.lockHash.hex) push(`${base}/sourceRef/lockHash`, 'source lockHash does not match the proposal');
    if (!expectedCandidate.has(entry.sourceRef.candidateDigest.hex)) push(`${base}/sourceRef/candidateDigest`, 'source candidateDigest does not match the settled run or incident');
    if ((entry.kind === 'fact' || entry.kind === 'invariant')
      && (resultStatus === null || !SETTLED_FACT_STATUSES.includes(resultStatus as (typeof SETTLED_FACT_STATUSES)[number]))) {
      push(`${base}/kind`, `kind ${entry.kind} requires a completed or no_change run`);
      continue;
    }
    if ((entry.kind === 'fact' || entry.kind === 'invariant') && entry.evidenceRefs.some(reference => reference.observedStatus !== 'passed')) {
      push(`${base}/evidenceRefs`, `${entry.kind} cites a check that is not passed`);
    }
    if (entry.scope.taskpack !== proposal.taskpack) push(`${base}/scope/taskpack`, 'entry scope taskpack does not match the proposal');
    if (entry.scope.repository !== proposal.repository) push(`${base}/scope/repository`, 'entry scope repository does not match the proposal');
    for (const [refIndex, reference] of entry.evidenceRefs.entries()) {
      const refPath = `${base}/evidenceRefs/${refIndex}`;
      if (input.result === null) {
        if (reference.evidenceId !== INCIDENT_EVIDENCE_ID || reference.checkId !== INCIDENT_CHECK_ID || reference.observedStatus !== 'not_run') {
          push(`${refPath}`, 'incident proposals may only cite the not_run incident reference');
          continue;
        }
        const incidentArtifact = input.incident === null ? null : reference.artifact.digest.hex === incidentReferenceDigest(input.incident).hex ? reference.artifact
          : input.incident.knownReferences.find(candidate => candidate.digest.hex === reference.artifact.digest.hex) ?? null;
        if (input.incident === null || incidentArtifact === null) push(`${refPath}/artifact`, 'incident evidence artifact does not match the incident');
        else {
          const inventory = input.artifacts.get(incidentArtifact.name);
          if (!inventory || inventory.byteLength !== incidentArtifact.byteLength || !digestEqual(inventory.digest, incidentArtifact.digest)) push(`${refPath}/artifact`, 'incident evidence artifact is absent from the run inventory');
        }
        continue;
      }
      const row = rows.find(candidate => candidate.evidenceId === reference.evidenceId);
      if (!row) { push(`${refPath}/evidenceId`, 'evidence reference has no verification row'); continue; }
      if (row.checkId !== reference.checkId) push(`${refPath}/checkId`, 'verification row checkId does not match');
      if (row.status !== reference.observedStatus) push(`${refPath}/observedStatus`, 'verification row status does not match');
      const document = evidenceById.get(reference.evidenceId);
      if (!document) { push(`${refPath}/evidenceId`, 'evidence document is missing from the authenticated inventory'); continue; }
      if (document.spec.checkId !== reference.checkId || document.spec.observedStatus !== reference.observedStatus) push(`${refPath}`, 'evidence document disagrees with the reference');
      if (document.spec.level !== reference.level) push(`${refPath}/level`, 'evidence document level does not match');
      if (!document.spec.artifacts.some(candidate => candidate.name === reference.artifact.name)) push(`${refPath}/artifact`, 'artifact is not part of the cited evidence');
      const inventory = input.artifacts.get(reference.artifact.name);
      if (!inventory || inventory.byteLength !== reference.artifact.byteLength || !digestEqual(inventory.digest, reference.artifact.digest)) push(`${refPath}/artifact`, 'artifact digest or length does not match the run inventory');
    }
  }
  return gate('provenance', diagnostics);
}
function scopeGate(input: MemoryVerificationInput, proposal: MemoryProposal): MemoryGateResult {
  const diagnostics: MemoryDiagnostic[] = [];
  const push = (path: string, detail: string) => diagnostics.push({ code: 'MEMORY_SCOPE_VIOLATION', path, detail });
  if (!input.memoryWritable.every(prefix => isMemoryManagedPath(proposal.taskpack, prefix))) push('/memoryWritable', 'memory writable roots must stay inside the taskpack memory directory');
  const targets = new Set<string>([`${memoryDirectoryFor(proposal.taskpack)}/index.json`]);
  for (const operation of proposal.operations) {
    if (operation.kind === 'upsert') targets.add(`${memoryDirectoryFor(proposal.taskpack)}/entries/${operation.entry.id}.md`);
    else targets.add(`${memoryDirectoryFor(proposal.taskpack)}/index.json`);
  }
  for (const path of parsePatchPaths(input.patch)) targets.add(path);
  const memoryPrefixes = input.memoryWritable.map(prefix => prefix.endsWith('/') ? prefix : `${prefix}/`);
  const contractScope = input.lock.spec.contract.spec.scope;
  for (const path of targets) {
    if (path.split('/').includes('..')) { push('/paths', `path ${path} contains path traversal`); continue; }
    if (!memoryPrefixes.some(prefix => path === prefix.slice(0, -1) || path.startsWith(prefix))) { push('/paths', `path ${path} escapes the memory writable roots`); continue; }
    if (path.startsWith('.github/') || path.startsWith('.loopwright/policies/')) push('/paths', `path ${path} touches a protected policy area`);
    if (input.protectedPaths.some(pattern => matchScopePattern(pattern, path))) push('/paths', `path ${path} matches a protected scope pattern`);
    if (contractScope.writable.some(pattern => matchScopePattern(pattern, path))) push('/paths', `path ${path} overlaps the contract writable scope`);
    if (contractScope.protected.some(pattern => matchScopePattern(pattern, path))) push('/paths', `path ${path} matches the contract protected scope`);
  }
  return gate('scope', diagnostics);
}
function redactionGate(input: MemoryVerificationInput, proposal: MemoryProposal): MemoryGateResult {
  const diagnostics: MemoryDiagnostic[] = [];
  const texts: readonly { readonly path: string; readonly content: string }[] = proposal.operations.flatMap((operation, index) => operation.kind === 'upsert'
    ? [{ path: `/proposal/operations/${index}/entry`, content: renderEntryMarkdown(operation.entry) }]
    : [{ path: `/proposal/operations/${index}/reason`, content: operation.reason }]);
  for (const { path, content } of texts) {
    for (const secret of input.secretValues) {
      if (secret.length > 0 && content.includes(secret)) diagnostics.push({ code: 'MEMORY_SECRET_LEAK', path, detail: 'caller-supplied secret value appears in proposal text' });
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.source.test(content)) diagnostics.push({ code: 'MEMORY_SECRET_LEAK', path, detail: `credential pattern detected: ${pattern.label}` });
    }
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.source.test(content)) diagnostics.push({ code: 'MEMORY_INJECTION_DETECTED', path, detail: `prompt-injection marker detected: ${pattern.label}` });
    }
    if (hasControlCharacter(content)) diagnostics.push({ code: 'MEMORY_INJECTION_DETECTED', path, detail: 'control character in proposal text' });
  }
  return gate('redaction', diagnostics);
}
function conflictGate(input: MemoryVerificationInput, proposal: MemoryProposal): MemoryGateResult {
  const diagnostics: MemoryDiagnostic[] = [];
  const push = (path: string, detail: string) => diagnostics.push({ code: 'MEMORY_CONFLICT_UNRESOLVED', path, detail });
  const upserts = proposal.operations.filter((operation): operation is Extract<MemoryOperation, { kind: 'upsert' }> => operation.kind === 'upsert');
  const tallies = new Map<string, { upserts: number; retires: number; firstUpsert: number; firstRetire: number }>();
  for (const [index, operation] of proposal.operations.entries()) {
    const target = operation.kind === 'upsert' ? operation.entry.id : operation.entryId;
    const tally = tallies.get(target) ?? { upserts: 0, retires: 0, firstUpsert: Number.MAX_SAFE_INTEGER, firstRetire: Number.MAX_SAFE_INTEGER };
    if (operation.kind === 'upsert') { tally.upserts++; tally.firstUpsert = Math.min(tally.firstUpsert, index); }
    else { tally.retires++; tally.firstRetire = Math.min(tally.firstRetire, index); }
    tallies.set(target, tally);
  }
  for (const [target, tally] of tallies) {
    if (tally.upserts > 1 || tally.retires > 1 || (tally.upserts === 1 && tally.retires === 1 && tally.firstRetire > tally.firstUpsert)) {
      push('/proposal/operations', `duplicate operation target ${target} is targeted more than once without a retire-before-upsert replacement`);
    }
  }
  for (const [index, upsert] of upserts.entries()) {
    for (const supersededId of upsert.entry.supersedes) {
      if (supersededId === upsert.entry.id) push(`/proposal/operations/${index}/entry/supersedes`, 'entry supersedes itself');
      if (!input.store.entries.some(candidate => candidate.id === supersededId)) push(`/proposal/operations/${index}/entry/supersedes`, `superseded id ${supersededId} is not an active base entry`);
    }
  }
  const edges = new Map<string, readonly string[]>(upserts.map(upsert => [upsert.entry.id, upsert.entry.supersedes.filter(id => upserts.some(other => other.entry.id === id))]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string, trail: readonly string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) push('/proposal/operations', `supersession cycle: ${[...trail, id].join(' -> ')}`);
    else {
      visiting.add(id);
      for (const next of edges.get(id) ?? []) visit(next, [...trail, id]);
      visiting.delete(id); visited.add(id);
    }
  };
  for (const id of edges.keys()) visit(id, []);
  const retiredTargets = new Set(proposal.operations.filter(operation => operation.kind === 'retire').map(operation => operation.entryId));
  for (const [index, upsert] of upserts.entries()) {
    if (input.store.entries.some(candidate => candidate.id === upsert.entry.id) && !retiredTargets.has(upsert.entry.id)) {
      push(`/proposal/operations/${index}/entry`, `upsert replaces active entry ${upsert.entry.id} without retiring it`);
    }
  }
  for (const [index, upsert] of upserts.entries()) {
    for (const base of input.store.entries) {
      if (base.id === upsert.entry.id) continue;
      const overlapping = base.claimKey === upsert.entry.claimKey
        && base.scope.taskpack === upsert.entry.scope.taskpack && base.scope.repository === upsert.entry.scope.repository
        && (base.scope.targetMatrix === null || upsert.entry.scope.targetMatrix === null
          || (base.scope.targetMatrix.id === upsert.entry.scope.targetMatrix.id && base.scope.targetMatrix.platform === upsert.entry.scope.targetMatrix.platform
            && base.scope.targetMatrix.variant === upsert.entry.scope.targetMatrix.variant));
      if (!overlapping) continue;
      const sharedKeys = Object.keys(base.validFor.upstreamVersions).filter(key => Object.hasOwn(upsert.entry.validFor.upstreamVersions, key));
      const diverged = sharedKeys.length > 0 && sharedKeys.every(key => upsert.entry.validFor.upstreamVersions[key] !== base.validFor.upstreamVersions[key]);
      if (diverged) continue;
      if (!upsert.entry.supersedes.includes(base.id)) push(`/proposal/operations/${index}/entry`, `conflicts with active entry ${base.id} over claimKey ${base.claimKey} without superseding it`);
    }
  }
  return gate('memory-review', diagnostics);
}
/** Deterministic five-gate verifier; never writes, never mutates its inputs. */
export function verifyMemoryProposal(input: MemoryVerificationInput): MemoryVerificationReport {
  const schema = schemaGate(input);
  const gates: MemoryGateResult[] = [schema.result];
  const proposal = schema.proposal;
  if (proposal === null) {
    gates.push(skippedGate('provenance'), skippedGate('scope'), skippedGate('redaction'), skippedGate('memory-review'));
    return { gates, satisfied: false };
  }
  gates.push(provenanceGate(input, proposal), scopeGate(input, proposal), redactionGate(input, proposal), conflictGate(input, proposal));
  return { gates, satisfied: gates.every(gate => gate.status === 'passed') };
}
/** Re-checks a proposal after a rebase, verifying the regenerated patch text as well. */
export function verifyRebasedProposal(input: MemoryVerificationInput, proposal: MemoryProposal, patch: string): MemoryVerificationReport {
  return verifyMemoryProposal({ ...input, proposal, patch });
}
