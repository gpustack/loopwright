import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { TaskContract } from '@loopwright/core';
import { applyMemoryProposalCAS } from '../src/cas.js';
import { canonical, memoryProposalSchema, renderEntryMarkdown, storeDigestOf } from '../src/schema.js';
import { selectActiveMemory } from '../src/selector.js';
import { entryFileBytes, loadMemoryStore, memoryDirectoryFor, MEMORY_ROOT } from '../src/store.js';
import { BASE_REVISION, buildRun, hex, inventoryMap, type RunFixture } from './run-fixtures.js';
import type { MemoryCASInput, MemoryEntry, MemoryOperation, MemoryProposal, MemoryStoreIndex, RetiredMemoryEntry } from '../src/types.js';

const TASKPACK = 'demo', RUN_ID = 'run.fixture.one';
async function withSandbox(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-cas-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
function seededEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { version: 1, id: 'entry.base', claimKey: 'claim.base', claim: 'Base claim text.', kind: 'fact',
    scope: { taskpack: TASKPACK, repository: 'org/repo', paths: ['src/**'], targetMatrix: null },
    sourceRef: { runId: RUN_ID, lockHash: hex('lock'), candidateDigest: hex('candidate') },
    sourceDigest: hex('source'), verifiedAtMs: 900,
    validFor: { baseRevision: BASE_REVISION, sourceRevision: 'c'.repeat(40), codeFingerprint: hex('fingerprint'), upstreamVersions: { npm: '1.0.0' } },
    expiresAtMs: 99_999, supersedes: [],
    evidenceRefs: [{ evidenceId: 'ev.base', checkId: 'check.base', level: 'local_execution', observedStatus: 'passed',
      artifact: { name: 'artifacts/base.json', digest: hex('base-artifact'), byteLength: 4 } }], ...overrides } as MemoryEntry;
}
async function seedStore(root: string, entries: readonly MemoryEntry[], retired: readonly RetiredMemoryEntry[] = []): Promise<MemoryStoreIndex> {
  const base = { version: 1 as const, taskpack: TASKPACK, repository: 'org/repo', updatedAtMs: 1500, entries, retired };
  const index: MemoryStoreIndex = { ...base, storeDigest: storeDigestOf(base) };
  const directory = join(root, MEMORY_ROOT, TASKPACK, 'entries');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of [...entries, ...retired.map(row => row.entry)]) await writeFile(join(directory, `${entry.id}.md`), entryFileBytes(entry), { mode: 0o600 });
  await writeFile(join(root, MEMORY_ROOT, TASKPACK, 'index.json'), Buffer.from(canonical(index)), { mode: 0o600 });
  return index;
}
function proposedEntry(fixture: RunFixture, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { version: 1, id: 'entry.proposed', claimKey: 'claim.proposed', claim: 'Proposed verified claim.', kind: 'fact',
    scope: { taskpack: TASKPACK, repository: 'org/repo', paths: ['src/**'], targetMatrix: null },
    sourceRef: { runId: RUN_ID, lockHash: fixture.lock.spec.lockHash, candidateDigest: fixture.result.spec.subject.candidateDigest },
    sourceDigest: hex('proposed-source'), verifiedAtMs: 1500,
    validFor: { baseRevision: BASE_REVISION, sourceRevision: 'c'.repeat(40), codeFingerprint: hex('fingerprint'), upstreamVersions: { npm: '1.0.0' } },
    expiresAtMs: 99_999, supersedes: [],
    evidenceRefs: [{ evidenceId: 'evidence.check.one', checkId: 'check.one', level: 'local_execution', observedStatus: 'passed',
      artifact: fixture.artifactRefs[1]! }], ...overrides } as MemoryEntry;
}
function supersedeOperations(fixture: RunFixture): MemoryOperation[] {
  return [
    { kind: 'upsert', entry: proposedEntry(fixture, { supersedes: ['entry.base'] }) },
    { kind: 'retire', entryId: 'entry.base', reason: 'superseded by entry.proposed' },
  ];
}
function buildProposal(fixture: RunFixture, baseStoreDigest: { algorithm: 'sha256'; hex: string }, operations: MemoryOperation[]): MemoryProposal {
  return memoryProposalSchema({ version: 1, proposalId: 'proposal.run.fixture.one.test', taskpack: TASKPACK, repository: 'org/repo',
    baseRevision: BASE_REVISION, baseStoreDigest, createdAtMs: 1500, runId: RUN_ID, lockHash: fixture.lock.spec.lockHash, operations }, '/proposal');
}
function casInput(root: string, fixture: RunFixture, proposal: MemoryProposal, baseStore: MemoryStoreIndex | null, overrides: Partial<MemoryCASInput> = {}): MemoryCASInput {
  return { repository: root, taskpack: TASKPACK, proposal, lock: fixture.lock, result: fixture.result, incident: null,
    evidence: fixture.evidence, artifacts: inventoryMap(fixture), candidateDigest: fixture.result.spec.subject.candidateDigest,
    secretValues: [], memoryWritable: [memoryDirectoryFor(TASKPACK)], protectedPaths: [], targetBranch: 'main',
    currentRevision: BASE_REVISION, baseStore, allowRebase: true, nowMs: 1500, ...overrides };
}
async function storeUnchanged(root: string, digest: { algorithm: 'sha256'; hex: string }): Promise<void> {
  const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
  assert.equal(reloaded.index.storeDigest.hex, digest.hex);
}
const cleanups: Promise<void>[] = [];
after(() => { return Promise.allSettled(cleanups); });

describe('compare-and-swap store update', () => {
  it('applies a fast-path proposal with retirement under the exclusive lock', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const proposal = buildProposal(fixture, baseIndex.storeDigest, supersedeOperations(fixture));
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, true);
      assert.equal(result.rebased, false);
      assert.equal(result.refusal, null);
      const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.equal(result.storeDigestAfter!.hex, reloaded.index.storeDigest.hex);
      assert.deepEqual(reloaded.index.entries.map(entry => entry.id), ['entry.proposed']);
      assert.equal(reloaded.index.retired.length, 1);
      assert.equal(reloaded.index.retired[0]!.retiredByProposalId, proposal.proposalId);
      assert.equal(reloaded.index.retired[0]!.supersededByEntryId, 'entry.proposed');
      const pullRequest = result.pullRequest!;
      assert.equal(pullRequest.mode, 'separate_pull_request');
      assert.equal(pullRequest.branchName, `loopwright/memory/${TASKPACK}/${proposal.proposalId}`);
      assert.equal(pullRequest.targetBranch, 'main');
      assert.equal(pullRequest.baseRevision, BASE_REVISION);
      assert.equal(pullRequest.excludesCodeCandidatePaths, true);
      for (const file of pullRequest.modifiedFiles) assert.ok(file.path.startsWith(`${MEMORY_ROOT}/${TASKPACK}/`));
      const lockFiles = (await readdir(join(root, MEMORY_ROOT, TASKPACK))).filter(name => name === '.cas.lock');
      assert.deepEqual(lockFiles, []);
      const modes = await stat(join(root, MEMORY_ROOT, TASKPACK, 'entries', 'entry.proposed.md'));
      assert.equal(modes.mode & 0o777, 0o600);
    });
  });

  it('refuses a failed verification with zero writes', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const forged = proposedEntry(fixture, { evidenceRefs: [{ evidenceId: 'evidence.check.one', checkId: 'check.one', level: 'local_execution',
        observedStatus: 'passed', artifact: { name: 'evidence-one.bin', digest: hex('forged'), byteLength: 7 } }] });
      const proposal = buildProposal(fixture, baseIndex.storeDigest, [{ kind: 'upsert', entry: forged }]);
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, false);
      assert.equal(result.refusal!.code, 'MEMORY_VERIFICATION_FAILED');
      await storeUnchanged(root, baseIndex.storeDigest);
    });
  });

  it('refuses when another apply holds the lock and leaves that lock intact', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const proposal = buildProposal(fixture, baseIndex.storeDigest, [{ kind: 'upsert', entry: proposedEntry(fixture) }]);
      const lockPath = join(root, MEMORY_ROOT, TASKPACK, '.cas.lock');
      const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await lock.writeFile('held elsewhere');
      await lock.close();
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, false);
      assert.equal(result.refusal!.code, 'MEMORY_CAS_CONFLICT');
      assert.equal(await readFileText(lockPath), 'held elsewhere');
      await storeUnchanged(root, baseIndex.storeDigest);
      await unlink(lockPath);
    });
  });

  it('rebases onto a disjoint concurrent change and re-verifies', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const concurrent = seededEntry({ id: 'entry.concurrent', claimKey: 'claim.concurrent', claim: 'Concurrent disjoint claim.' });
      const currentIndex = await seedStore(root, [seededEntry(), concurrent]);
      void currentIndex;
      const proposal = buildProposal(fixture, baseIndex.storeDigest, supersedeOperations(fixture));
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, true);
      assert.equal(result.rebased, true);
      const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.deepEqual(reloaded.index.entries.map(entry => entry.id), ['entry.concurrent', 'entry.proposed']);
      assert.equal(reloaded.index.retired.length, 1);
    });
  });

  it('fails closed on overlapping ids or claim keys, disallowed rebase, and unknown base', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const proposal = buildProposal(fixture, baseIndex.storeDigest, supersedeOperations(fixture));
      const rewritten = await seedStore(root, [seededEntry({ claim: 'Concurrently rewritten base claim.' })]);
      const idConflict = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(idConflict.applied, false);
      assert.equal(idConflict.refusal!.code, 'MEMORY_CAS_CONFLICT');
      await storeUnchanged(root, rewritten.storeDigest);
      const collided = await seedStore(root, [seededEntry(), seededEntry({ id: 'entry.other', claimKey: 'claim.proposed', claim: 'Concurrent claim-key collision.' })]);
      const claimConflict = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(claimConflict.applied, false);
      assert.equal(claimConflict.refusal!.code, 'MEMORY_CAS_CONFLICT');
      const disallowed = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex, { allowRebase: false }));
      assert.equal(disallowed.applied, false);
      assert.equal(disallowed.refusal!.code, 'MEMORY_CAS_CONFLICT');
      const unknownBase = await applyMemoryProposalCAS(casInput(root, fixture, proposal, null));
      assert.equal(unknownBase.applied, false);
      assert.equal(unknownBase.refusal!.code, 'MEMORY_CAS_CONFLICT');
      await storeUnchanged(root, collided.storeDigest);
    });
  });

  it('bootstraps an empty store on the fast path with a new-file index patch', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = (await loadMemoryStore(root, TASKPACK, 'org/repo')).index;
      const entry = proposedEntry(fixture);
      const proposal = buildProposal(fixture, baseIndex.storeDigest, [{ kind: 'upsert', entry }]);
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, true);
      assert.equal(result.rebased, false);
      const entryPath = `${memoryDirectoryFor(TASKPACK)}/entries/entry.proposed.md`;
      const content = renderEntryMarkdown(entry);
      const expectedEntryDiff = `--- /dev/null\n+++ b/${entryPath}\n@@ -0,0 +1,5 @@\n${
        content.split('\n').slice(0, -1).map(line => '+' + line).join('\n') }\n`;
      assert.ok(result.pullRequest!.patch.startsWith(expectedEntryDiff));
      assert.ok(result.pullRequest!.patch.includes(`--- /dev/null\n+++ b/${memoryDirectoryFor(TASKPACK)}/index.json`));
      assert.ok(result.pullRequest!.patch.endsWith('\n'));
      assert.ok(result.pullRequest!.body.includes('1 addition(s)/replacement(s), 0 retirement(s)'));
      assert.ok(result.pullRequest!.body.includes(`evidence-one.bin:${fixture.artifactRefs[1]!.digest.hex}`));
      const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.equal(reloaded.index.repository, 'org/repo');
      assert.equal(result.storeDigestAfter!.hex, reloaded.index.storeDigest.hex);
    });
  });

  it('rolls back every write and cleans up when the apply fails mid-way', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const proposal = buildProposal(fixture, baseIndex.storeDigest, supersedeOperations(fixture));
      const concurrentProposal = buildProposal(fixture, baseIndex.storeDigest, [{ kind: 'upsert', entry: proposedEntry(fixture, { id: 'entry.second', claimKey: 'claim.second', claim: 'Concurrent second claim.' }) }]);
      await assert.rejects(() => applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex, {
        faultInjectionHook: async () => {
          const concurrent = await applyMemoryProposalCAS(casInput(root, fixture, concurrentProposal, baseIndex));
          assert.equal(concurrent.applied, false);
          assert.equal(concurrent.refusal!.code, 'MEMORY_CAS_CONFLICT');
          const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
          assert.equal(reloaded.index.storeDigest.hex, baseIndex.storeDigest.hex);
          assert.deepEqual(reloaded.index.entries.map(entry => entry.id), ['entry.base']);
          const committedEntryBytes = reloaded.entryFiles.get('entry.base')!;
          assert.ok(Buffer.from(committedEntryBytes).equals(Buffer.from(entryFileBytes(reloaded.index.entries[0]!))));
          throw new Error('injected fault');
        },
      })), /injected fault/);
      await storeUnchanged(root, baseIndex.storeDigest);
      const taskpackFiles = await readdir(join(root, MEMORY_ROOT, TASKPACK));
      assert.deepEqual(taskpackFiles.filter(name => name.includes('.tmp-')), []);
      assert.deepEqual(taskpackFiles.filter(name => name === '.cas.lock'), []);
      const entryFiles = await readdir(join(root, MEMORY_ROOT, TASKPACK, 'entries'));
      assert.deepEqual(entryFiles.filter(name => name.includes('.tmp-')), []);
      assert.deepEqual(entryFiles.filter(name => name !== 'entry.base.md'), []);
    });
  });

  it('keeps a committed retire-then-upsert replacement active in the snapshot', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const replacement = seededEntry({ claim: 'Replacement claim text with new evidence.',
        sourceRef: { runId: RUN_ID, lockHash: fixture.lock.spec.lockHash, candidateDigest: fixture.result.spec.subject.candidateDigest },
        evidenceRefs: [{ evidenceId: 'evidence.check.one', checkId: 'check.one', level: 'local_execution', observedStatus: 'passed',
          artifact: fixture.artifactRefs[1]! }] });
      const proposal = buildProposal(fixture, baseIndex.storeDigest, [
        { kind: 'retire', entryId: 'entry.base', reason: 'replaced in place' },
        { kind: 'upsert', entry: replacement },
      ]);
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, true);
      const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.deepEqual(reloaded.index.entries.map(entry => entry.id), ['entry.base']);
      assert.equal(reloaded.index.entries[0]!.claim, 'Replacement claim text with new evidence.');
      assert.equal(reloaded.index.retired.length, 1);
      const contract = { spec: { taskpack: TASKPACK, target: { repository: 'org/repo' }, trustedContext: { resources: [] } } } as unknown as TaskContract;
      const snapshot = selectActiveMemory({ store: reloaded.index, contract, nowMs: 1500,
        currentCodeFingerprint: hex('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null });
      assert.deepEqual(snapshot.activeEntries.map(entry => entry.id), ['entry.base']);
      assert.equal(snapshot.activeEntries[0]!.claim, 'Replacement claim text with new evidence.');
      assert.deepEqual(snapshot.excludedEntries, []);
      const afterReplacement = await loadMemoryStore(root, TASKPACK, 'org/repo');
      const retireProposal = buildProposal(fixture, afterReplacement.index.storeDigest, [
        { kind: 'retire', entryId: 'entry.base', reason: 'replacement retired again' },
      ]);
      const retireResult = await applyMemoryProposalCAS(casInput(root, fixture, retireProposal, afterReplacement.index));
      assert.equal(retireResult.applied, true);
      const afterRetire = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.deepEqual(afterRetire.index.entries.map(entry => entry.id), []);
      assert.equal(afterRetire.index.retired.length, 1);
      assert.equal(afterRetire.index.retired[0]!.entry.claim, 'Replacement claim text with new evidence.');
      assert.deepEqual(afterRetire.index.retired.map(row => row.entry.id), ['entry.base']);
      const retiredSnapshot = selectActiveMemory({ store: afterRetire.index, contract, nowMs: 1500,
        currentCodeFingerprint: hex('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null });
      assert.deepEqual(retiredSnapshot.activeEntries.map(entry => entry.id), []);
    });
  });

  it('supersedes a replaced entry and keeps index.retired unique', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const baseIndex = await seedStore(root, [seededEntry()]);
      const replacement = seededEntry({ claim: 'Replacement claim text with new evidence.',
        sourceRef: { runId: RUN_ID, lockHash: fixture.lock.spec.lockHash, candidateDigest: fixture.result.spec.subject.candidateDigest },
        evidenceRefs: [{ evidenceId: 'evidence.check.one', checkId: 'check.one', level: 'local_execution', observedStatus: 'passed',
          artifact: fixture.artifactRefs[1]! }] });
      const replacementProposal = buildProposal(fixture, baseIndex.storeDigest, [
        { kind: 'retire', entryId: 'entry.base', reason: 'replaced in place' },
        { kind: 'upsert', entry: replacement },
      ]);
      const replacementResult = await applyMemoryProposalCAS(casInput(root, fixture, replacementProposal, baseIndex));
      assert.equal(replacementResult.applied, true);
      const afterReplacement = await loadMemoryStore(root, TASKPACK, 'org/repo');
      const successorProposal = buildProposal(fixture, afterReplacement.index.storeDigest, [
        { kind: 'upsert', entry: proposedEntry(fixture, { id: 'entry.successor', claimKey: 'claim.successor', claim: 'Successor claim.', supersedes: ['entry.base'] }) },
      ]);
      const successorResult = await applyMemoryProposalCAS(casInput(root, fixture, successorProposal, afterReplacement.index));
      assert.equal(successorResult.applied, true);
      const afterSuccessor = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.deepEqual(afterSuccessor.index.entries.map(entry => entry.id), ['entry.successor']);
      assert.deepEqual(afterSuccessor.index.retired.map(row => row.entry.id), ['entry.base']);
      assert.equal(afterSuccessor.index.retired[0]!.entry.claim, 'Replacement claim text with new evidence.');
      assert.equal(afterSuccessor.index.retired[0]!.supersededByEntryId, 'entry.successor');
      const contract = { spec: { taskpack: TASKPACK, target: { repository: 'org/repo' }, trustedContext: { resources: [] } } } as unknown as TaskContract;
      const snapshot = selectActiveMemory({ store: afterSuccessor.index, contract, nowMs: 1500,
        currentCodeFingerprint: hex('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null });
      assert.deepEqual(snapshot.activeEntries.map(entry => entry.id), ['entry.successor']);
      assert.deepEqual(snapshot.excludedEntries.map(row => [row.entryId, row.reason]), [['entry.base', 'superseded']]);
    });
  });

  it('rebases a proposal that reuses a historically retired claim key', async () => {
    const fixture = await buildRun('completed');
    await withSandbox(async root => {
      const historic = seededEntry({ id: 'entry.historic', claimKey: 'claim.proposed' });
      const retiredRow = { entry: historic, retiredAtMs: 1200, retiredByProposalId: 'proposal.historic', supersededByEntryId: null };
      const baseIndex = await seedStore(root, [], [retiredRow]);
      const concurrent = seededEntry({ id: 'entry.concurrent', claimKey: 'claim.concurrent', claim: 'Concurrent disjoint claim.' });
      await seedStore(root, [concurrent], [retiredRow]);
      const proposal = buildProposal(fixture, baseIndex.storeDigest, [{ kind: 'upsert', entry: proposedEntry(fixture) }]);
      const result = await applyMemoryProposalCAS(casInput(root, fixture, proposal, baseIndex));
      assert.equal(result.applied, true);
      assert.equal(result.rebased, true);
      const reloaded = await loadMemoryStore(root, TASKPACK, 'org/repo');
      assert.deepEqual(reloaded.index.entries.map(entry => entry.id), ['entry.concurrent', 'entry.proposed']);
      assert.equal(reloaded.index.retired.length, 1);
    });
  });
});
function readFileText(path: string): Promise<string> { return import('node:fs/promises').then(fs => fs.readFile(path, 'utf8')); }
