import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Digest, TaskContract } from '@loopwright/core';
import { canonical, storeDigestOf } from '../src/schema.js';
import { computeCodeFingerprint, entryFileBytes, forbiddenMemoryArtifactName, isMemoryManagedPath, loadMemoryStore, matchScopePattern, MEMORY_ROOT } from '../src/store.js';
import { bindMemorySnapshotToResource, memorySnapshotBindingMatches, memorySnapshotResourceId, selectActiveMemory } from '../src/selector.js';
import type { ActiveMemorySnapshot, MemoryEntry, MemoryStoreIndex, RetiredMemoryEntry } from '../src/types.js';

function hex(seed: string): Digest {
  return { algorithm: 'sha256', hex: createHash('sha256').update(seed).digest('hex') };
}
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const base: MemoryEntry = {
    version: 1, id: 'entry.alpha', claimKey: 'claim.alpha', claim: 'Stable claim text.', kind: 'fact',
    scope: { taskpack: 'demo', repository: 'org/repo', paths: ['docs/**'], targetMatrix: null },
    sourceRef: { runId: 'run.one', lockHash: hex('lock'), candidateDigest: hex('candidate') },
    sourceDigest: hex('source'), verifiedAtMs: 1000,
    validFor: { baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), codeFingerprint: hex('fingerprint'), upstreamVersions: { npm: '1.0.0' } },
    expiresAtMs: 2000, supersedes: [],
    evidenceRefs: [{ evidenceId: 'ev.one', checkId: 'check.one', level: 'local_execution', observedStatus: 'passed',
      artifact: { name: 'artifacts/evidence.json', digest: hex('artifact'), byteLength: 10 } }],
  };
  return Object.freeze({ ...base, ...overrides }) as MemoryEntry;
}
async function withSandbox(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-memory-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function writeStore(root: string, taskpack: string, entries: readonly MemoryEntry[], retired: readonly RetiredMemoryEntry[] = [], updatedAtMs = 1500): Promise<MemoryStoreIndex> {
  const base = { version: 1 as const, taskpack, repository: 'org/repo', updatedAtMs, entries, retired };
  const index: MemoryStoreIndex = { ...base, storeDigest: storeDigestOf(base) };
  const directory = join(root, '.loopwright', 'memory', taskpack, 'entries');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of [...entries, ...retired.map(row => row.entry)]) {
    await writeFile(join(directory, `${entry.id}.md`), entryFileBytes(entry), { mode: 0o600 });
  }
  await writeFile(join(root, '.loopwright', 'memory', taskpack, 'index.json'), Buffer.from(canonical(index)), { mode: 0o600 });
  return index;
}
function selectorInput(store: MemoryStoreIndex, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { store, contract, nowMs: 1500, currentCodeFingerprint: hex('fingerprint'), currentUpstreamVersions: { npm: '1.0.0' }, targetCell: null, ...overrides };
}
const contract = {
  apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract',
  spec: {
    goal: 'demo goal', taskpack: 'demo',
    target: { repository: 'org/repo', baseRevision: 'b'.repeat(40), sourceRevision: 'c'.repeat(40), matrix: null },
    scope: { writable: ['src/**'], protected: [] },
    roles: [{ id: 'coder', adapter: 'pi', provider: 'p', model: 'm', thinking: 'off', tools: [] }],
    trustedContext: { revision: 'rev', discovery: 'disabled', resources: [] },
    budgets: { wallTimeMs: 1, totalTokens: 1, perCallOutputTokens: 1, maxModelCalls: 1, maxConcurrency: 1, maxFormatRepairs: 0, maxImplementationRepairs: 0, maxTransportRetries: 0,
      enforcement: { wallTime: 'soft_accounting', tokens: 'soft_accounting', modelCalls: 'soft_accounting', concurrency: 'soft_accounting', formatRepairs: 'soft_accounting', implementationRepairs: 'soft_accounting', transportRetries: 'soft_accounting' } },
    steps: [{ id: 'work', kind: 'agent', uses: 'work', roleId: 'coder', dependsOn: [] }],
    acceptance: { required: ['check.one'], checks: [{ id: 'check.one', allowedEvidenceLevels: ['local_execution'] }] },
  },
} as unknown as TaskContract;
const cleanups: Promise<void>[] = [];
after(() => { return Promise.allSettled(cleanups); });

describe('memory store layout', () => {
  it('round-trips an index and its entry files', async () => {
    await withSandbox(async root => {
      const entry = makeEntry();
      const index = await writeStore(root, 'demo', [entry]);
      const loaded = await loadMemoryStore(root, 'demo', 'org/repo');
      assert.equal(loaded.index.entries.length, 1);
      assert.equal(loaded.index.storeDigest.hex, index.storeDigest.hex);
      assert.ok(loaded.entryFiles.has('entry.alpha'));
      assert.equal(canonical(loaded.index.entries[0]!), canonical(entry));
    });
  });

  it('reads a missing store as empty', async () => {
    await withSandbox(async root => {
      const loaded = await loadMemoryStore(root, 'demo', 'org/repo');
      assert.equal(loaded.index.entries.length, 0);
      assert.equal(loaded.index.retired.length, 0);
    });
  });

  it('does not grant staging tolerance to a stale or unstructured lock', async () => {
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      const drifted = makeEntry({ claim: 'Tampered claim.' });
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.alpha.md'), entryFileBytes(drifted), { mode: 0o600 });
      const lockPath = join(root, MEMORY_ROOT, 'demo', '.cas.lock');
      await writeFile(lockPath, Buffer.from(canonical({ version: 1, pid: 99999999, nonce: 'a'.repeat(12), proposalId: 'proposal.stale',
        acquiredAtMs: 0, touchedEntryIds: ['entry.alpha'] })), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /entry file does not match index row/);
      await writeFile(lockPath, Buffer.from('held elsewhere'), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /entry file does not match index row/);
    });
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.orphan.md'), entryFileBytes(entry), { mode: 0o600 });
      const lockPath = join(root, MEMORY_ROOT, 'demo', '.cas.lock');
      await writeFile(lockPath, Buffer.from(canonical({ version: 1, pid: 99999999, nonce: 'b'.repeat(12), proposalId: 'proposal.stale',
        acquiredAtMs: 0, touchedEntryIds: ['entry.orphan'] })), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /entry file has no index row/);
      await writeFile(lockPath, Buffer.from('not json at all'), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /entry file has no index row/);
    });
  });

  it('grants scoped staging tolerance to a live lock with committed entry bytes', async () => {
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      const inFlight = makeEntry({ claim: 'In-flight replacement claim.' });
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.alpha.md'), entryFileBytes(inFlight), { mode: 0o600 });
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', `entry.alpha.md.tmp-${process.pid}-cccccccccccc`), Buffer.from('x'), { mode: 0o600 });
      const lockPath = join(root, MEMORY_ROOT, 'demo', '.cas.lock');
      await writeFile(lockPath, Buffer.from(canonical({ version: 1, pid: process.pid, nonce: 'c'.repeat(12), proposalId: 'proposal.live',
        acquiredAtMs: 0, touchedEntryIds: ['entry.alpha'] })), { mode: 0o600 });
      const loaded = await loadMemoryStore(root, 'demo', 'org/repo');
      assert.deepEqual(loaded.index.entries.map(item => item.id), ['entry.alpha']);
      assert.ok(Buffer.from(loaded.entryFiles.get('entry.alpha')!).equals(Buffer.from(entryFileBytes(entry))));
      await rm(lockPath);
      await rm(join(root, MEMORY_ROOT, 'demo', 'entries', `entry.alpha.md.tmp-${process.pid}-cccccccccccc`));
    });
  });

  it('refuses traversal and invalid taskpack identifiers', async () => {
    await withSandbox(async root => {
      await assert.rejects(() => loadMemoryStore(root, 'demo/..', 'org/repo'), /identifier pattern mismatch/);
      await assert.rejects(() => loadMemoryStore(root, 'Demo', 'org/repo'), /identifier pattern mismatch/);
    });
  });

  it('refuses forbidden artifact names', async () => {
    await withSandbox(async root => {
      await writeStore(root, 'demo', []);
      await writeFile(join(root, MEMORY_ROOT, 'run.json'), Buffer.from('x'), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /forbidden artifact/);
    });
  });

  it('rejects unknown files under the taskpack store', async () => {
    await withSandbox(async root => {
      await writeStore(root, 'demo', []);
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'random.txt'), Buffer.from('x'), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /unexpected file in memory directory/);
    });
    await withSandbox(async root => {
      await writeStore(root, 'demo', []);
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'checkpoint.json'), Buffer.from('{}'), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /unexpected file in memory directory/);
    });
  });

  it('refuses checkpoint-named entry files', async () => {
    await withSandbox(async root => {
      const entry = makeEntry({ id: 'entry.checkpoint.note', claimKey: 'claim.checkpoint' });
      await writeStore(root, 'demo', [entry]);
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /forbidden artifact/);
    });
  });

  it('reads a missing store as empty under the repository slug', async () => {
    await withSandbox(async root => {
      const loaded = await loadMemoryStore(root, 'demo', 'acme/widget');
      assert.equal(loaded.index.repository, 'acme/widget');
      assert.equal(loaded.index.entries.length, 0);
      assert.equal((await loadMemoryStore(root, 'demo', 'org/repo')).index.repository, 'org/repo');
    });
  });

  it('refuses symlinked entry files and directories', async () => {
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      const outside = join(root, 'outside.md');
      await writeFile(outside, entryFileBytes(entry), { mode: 0o600 });
      await rm(join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.alpha.md'));
      await symlink(outside, join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.alpha.md'));
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /symbolic links are refused/);
    });
  });

  it('refuses a tampered index digest and orphan or missing entry files', async () => {
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      const indexPath = join(root, MEMORY_ROOT, 'demo', 'index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
      index['storeDigest'] = { algorithm: 'sha256', hex: 'f'.repeat(64) };
      await writeFile(indexPath, Buffer.from(canonical(index)), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /store digest does not match/);
    });
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.orphan.md'), entryFileBytes(entry), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /no index row/);
    });
    await withSandbox(async root => {
      const entry = makeEntry({ id: 'entry.beta', claimKey: 'claim.beta' });
      const base = { version: 1 as const, taskpack: 'demo', repository: 'org/repo', updatedAtMs: 1500, entries: [entry], retired: [] };
      const index: MemoryStoreIndex = { ...base, storeDigest: storeDigestOf(base) };
      const directory = join(root, '.loopwright', 'memory', 'demo', 'entries');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'index.json'), Buffer.from(canonical(index)), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /no entry file/);
    });
  });

  it('refuses an entry file that drifts from its index row', async () => {
    await withSandbox(async root => {
      const entry = makeEntry();
      await writeStore(root, 'demo', [entry]);
      const drifted = makeEntry({ claim: 'Rewritten claim text.' });
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', 'entry.alpha.md'), entryFileBytes(drifted), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /does not match index row/);
    });
  });

  it('refuses unexpected non-markdown files in entries', async () => {
    await withSandbox(async root => {
      await writeStore(root, 'demo', []);
      await writeFile(join(root, MEMORY_ROOT, 'demo', 'entries', 'notes.txt'), Buffer.from('x'), { mode: 0o600 });
      await assert.rejects(() => loadMemoryStore(root, 'demo', 'org/repo'), /unexpected non-markdown/);
    });
  });
});

describe('code fingerprint', () => {
  it('is stable, order-independent, and sensitive to content and path changes', async () => {
    await withSandbox(async root => {
      await mkdir(join(root, 'docs'), { recursive: true });
      await writeFile(join(root, 'docs', 'a.md'), Buffer.from('alpha'), { mode: 0o600 });
      await writeFile(join(root, 'docs', 'b.md'), Buffer.from('beta'), { mode: 0o600 });
      const first = await computeCodeFingerprint(root, ['docs/**']);
      const second = await computeCodeFingerprint(root, ['docs/**']);
      const reordered = await computeCodeFingerprint(root, ['docs/b.md', 'docs/a.md']);
      assert.equal(first.hex, second.hex);
      assert.equal(first.hex, reordered.hex);
      await writeFile(join(root, 'docs', 'a.md'), Buffer.from('alpha!'), { mode: 0o600 });
      const changed = await computeCodeFingerprint(root, ['docs/**']);
      assert.notEqual(first.hex, changed.hex);
      const narrower = await computeCodeFingerprint(root, ['docs/a.md']);
      assert.notEqual(changed.hex, narrower.hex);
    });
  });

  it('defines a digest for an empty match set and follows glob semantics', async () => {
    await withSandbox(async root => {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'a.ts'), Buffer.from('x'), { mode: 0o600 });
      const empty = await computeCodeFingerprint(root, ['nope/**']);
      const emptyAgain = await computeCodeFingerprint(root, ['nope/**']);
      assert.equal(empty.hex, emptyAgain.hex);
      assert.notEqual(empty.hex, (await computeCodeFingerprint(root, ['src/*.ts'])).hex);
    });
  });

  it('matches scope patterns like the core grammar', () => {
    assert.equal(matchScopePattern('docs/**', 'docs/a.md'), true);
    assert.equal(matchScopePattern('docs/**', 'docs/a/b.md'), true);
    assert.equal(matchScopePattern('docs/**', 'docs'), false);
    assert.equal(matchScopePattern('**/b.md', 'b.md'), true);
    assert.equal(matchScopePattern('**/b.md', 'x/y/b.md'), true);
    assert.equal(matchScopePattern('src/*.ts', 'src/a.ts'), true);
    assert.equal(matchScopePattern('src/*.ts', 'src/a/b.ts'), false);
    assert.equal(matchScopePattern('src/?.ts', 'src/a.ts'), true);
    assert.equal(matchScopePattern('src/?.ts', 'src/ab.ts'), false);
    assert.equal(matchScopePattern('a/**/b.md', 'a/b.md'), true);
    assert.equal(matchScopePattern('a/**/b.md', 'a/x/y/b.md'), true);
  });
});

describe('active memory selector', () => {
  it('keeps the snapshot digest stable across the clock when entries are expired', async () => {
    const store = await buildStore([makeEntry()]);
    const at3000 = selectActiveMemory(selectorInput(store, { nowMs: 3000 }) as never);
    const at4000 = selectActiveMemory(selectorInput(store, { nowMs: 4000 }) as never);
    assert.deepEqual(at3000.excludedEntries.map(row => row.reason), ['expired']);
    assert.ok(at3000.excludedEntries[0]!.detail.length > 0);
    assert.ok(!at3000.excludedEntries[0]!.detail.includes('3000'));
    assert.equal(at3000.snapshotDigest.hex, at4000.snapshotDigest.hex);
  });

  it('ignores supersession by an expired successor', async () => {
    const prior = makeEntry();
    const expiredSuccessor = makeEntry({ id: 'entry.beta', claimKey: 'claim.beta', expiresAtMs: 1200, supersedes: ['entry.alpha'] });
    const snapshot = selectActiveMemory(selectorInput(await buildStore([prior, expiredSuccessor])) as never);
    assert.deepEqual(snapshot.activeEntries.map(entry => entry.id), ['entry.alpha']);
    assert.deepEqual(snapshot.excludedEntries.map(row => [row.entryId, row.reason]), [['entry.beta', 'expired']]);
  });

  it('keeps a valid fact active and produces a deterministic digest', async () => {
    const store = await buildStore([makeEntry()]);
    const first = selectActiveMemory(selectorInput(store) as never);
    const second = selectActiveMemory(selectorInput(store, { nowMs: 1600 }) as never);
    assert.equal(first.activeEntries.length, 1);
    assert.equal(first.excludedEntries.length, 0);
    assert.equal(first.snapshotDigest.hex, second.snapshotDigest.hex);
    assert.ok(first.renderedMarkdown.includes('## Verified Facts'));
    assert.ok(first.renderedMarkdown.includes('## Failure Observations'));
    assert.ok(first.renderedMarkdown.includes('Stable claim text.'));
  });

  it('excludes expired entries first', async () => {
    const store = await buildStore([makeEntry({ validFor: { ...makeEntry().validFor, codeFingerprint: hex('other') } })]);
    const snapshot = selectActiveMemory(selectorInput(store, { nowMs: 2500 }) as never);
    assert.deepEqual(snapshot.excludedEntries.map(row => row.reason), ['expired']);
    assert.equal(snapshot.activeEntries.length, 0);
    const [row] = snapshot.excludedEntries;
    assert.equal(row!.entryId, 'entry.alpha');
    assert.equal(row!.claimKey, 'claim.alpha');
    assert.ok(row!.detail.length > 0);
  });

  it('excludes entries superseded by an active successor or by retirement', async () => {
    const successor = makeEntry({ id: 'entry.beta', claimKey: 'claim.beta', supersedes: ['entry.alpha'] });
    const store = await buildStore([makeEntry(), successor]);
    const snapshot = selectActiveMemory(selectorInput(store) as never);
    assert.deepEqual(snapshot.excludedEntries.map(row => row.reason), ['superseded']);
    assert.deepEqual(snapshot.activeEntries.map(entry => entry.id), ['entry.beta']);
    const retired = makeEntry({ id: 'entry.old', claimKey: 'claim.old', kind: 'failure_observation',
      evidenceRefs: [{ evidenceId: 'ev.two', checkId: 'check.two', level: 'local_execution', observedStatus: 'failed',
        artifact: { name: 'artifacts/failure.json', digest: hex('failure'), byteLength: 4 } }] });
    const retiredStore = await buildStore([makeEntry()], [{ entry: retired, retiredAtMs: 1200, retiredByProposalId: 'proposal.one', supersededByEntryId: null }]);
    const retiredSnapshot = selectActiveMemory(selectorInput(retiredStore) as never);
    assert.deepEqual(retiredSnapshot.excludedEntries.map(row => [row.entryId, row.reason]), [['entry.old', 'superseded']]);
  });

  it('excludes fingerprint drift, upstream drift, and scope mismatch', async () => {
    const store = await buildStore([makeEntry()]);
    assert.deepEqual(selectActiveMemory(selectorInput(store, { currentCodeFingerprint: hex('drift') }) as never).excludedEntries.map(row => row.reason), ['fingerprint_mismatch']);
    assert.deepEqual(selectActiveMemory(selectorInput(store, { currentUpstreamVersions: { npm: '2.0.0' } }) as never).excludedEntries.map(row => row.reason), ['upstream_version_changed']);
    assert.deepEqual(selectActiveMemory(selectorInput(store, { contract: { ...contract, spec: { ...contract.spec, taskpack: 'other' } } }) as never).excludedEntries.map(row => row.reason), ['scope_mismatch']);
    const matrixEntry = makeEntry({ scope: { ...makeEntry().scope, targetMatrix: { id: 'cuda', platform: 'linux', variant: 'aarch64' } } });
    const matrixStore = await buildStore([matrixEntry]);
    assert.deepEqual(selectActiveMemory(selectorInput(matrixStore, { targetCell: { id: 'rocm', platform: 'linux', variant: 'aarch64' } }) as never).excludedEntries.map(row => row.reason), ['scope_mismatch']);
    assert.equal(selectActiveMemory(selectorInput(matrixStore, { targetCell: { id: 'cuda', platform: 'linux', variant: 'aarch64' } }) as never).activeEntries.length, 1);
    assert.equal(selectActiveMemory(selectorInput(matrixStore) as never).activeEntries.length, 1);
  });

  it('excludes unverified facts, invariants without proof, and unproven hardware claims', async () => {
    const noPassed = makeEntry({ evidenceRefs: [{ evidenceId: 'ev.three', checkId: 'check.three', level: 'local_execution', observedStatus: 'not_run',
      artifact: { name: 'artifacts/none.json', digest: hex('none'), byteLength: 1 } }] });
    assert.deepEqual(selectActiveMemory(selectorInput(await buildStore([noPassed])) as never).excludedEntries.map(row => row.reason), ['unverified_claim']);
    const failedRef = makeEntry({ evidenceRefs: [makeEntry().evidenceRefs[0]!,
      { evidenceId: 'ev.four', checkId: 'check.four', level: 'local_execution', observedStatus: 'failed',
        artifact: { name: 'artifacts/fail.json', digest: hex('fail'), byteLength: 2 } }] });
    assert.deepEqual(selectActiveMemory(selectorInput(await buildStore([failedRef])) as never).excludedEntries.map(row => row.reason), ['unverified_claim']);
    const unprovenHardware = makeEntry({ evidenceRefs: [makeEntry().evidenceRefs[0]!,
      { evidenceId: 'ev.five', checkId: 'check.five', level: 'hardware_execution', observedStatus: 'blocked',
        artifact: { name: 'artifacts/blocked.json', digest: hex('blocked'), byteLength: 3 } }] });
    assert.deepEqual(selectActiveMemory(selectorInput(await buildStore([unprovenHardware])) as never).excludedEntries.map(row => row.reason), ['hardware_or_gate_unproven']);
    const observation = makeEntry({ id: 'entry.obs', claimKey: 'claim.obs', kind: 'failure_observation',
      evidenceRefs: [{ evidenceId: 'ev.six', checkId: 'check.six', level: 'local_execution', observedStatus: 'failed',
        artifact: { name: 'artifacts/obs.json', digest: hex('obs'), byteLength: 5 } }] });
    const mixed = selectActiveMemory(selectorInput(await buildStore([observation, makeEntry()])) as never);
    assert.equal(mixed.activeEntries.length, 2);
    assert.ok(mixed.renderedMarkdown.indexOf('## Failure Observations') > mixed.renderedMarkdown.indexOf('## Verified Facts'));
    assert.ok(mixed.renderedMarkdown.includes('- entry.obs'));
  });

  it('sorts active entries by id and never renders failures as facts', async () => {
    const first = makeEntry({ id: 'entry.zz', claimKey: 'claim.zz' });
    const second = makeEntry({ id: 'entry.aa', claimKey: 'claim.aa' });
    const snapshot = selectActiveMemory(selectorInput(await buildStore([first, second])) as never);
    assert.deepEqual(snapshot.activeEntries.map(entry => entry.id), ['entry.aa', 'entry.zz']);
    const failure = makeEntry({ id: 'entry.fail', claimKey: 'claim.fail', kind: 'failure_observation',
      evidenceRefs: [{ evidenceId: 'ev.seven', checkId: 'check.seven', level: 'local_execution', observedStatus: 'failed',
        artifact: { name: 'artifacts/seven.json', digest: hex('seven'), byteLength: 7 } }] });
    const withFailure = selectActiveMemory(selectorInput(await buildStore([failure])) as never);
    const factsSection = withFailure.renderedMarkdown.slice(0, withFailure.renderedMarkdown.indexOf('## Failure Observations'));
    assert.ok(!factsSection.includes('entry.fail'));
  });

  it('changes the digest when the store content changes', async () => {
    const base = selectActiveMemory(selectorInput(await buildStore([makeEntry()])) as never);
    const withMore = selectActiveMemory(selectorInput(await buildStore([makeEntry(), makeEntry({ id: 'entry.second', claimKey: 'claim.second' })])) as never);
    assert.notEqual(base.snapshotDigest.hex, withMore.snapshotDigest.hex);
  });
});

describe('snapshot resource binding', () => {
  it('binds a resource descriptor and verifies contract digests', async () => {
    const snapshot: ActiveMemorySnapshot = selectActiveMemory(selectorInput(await buildStore([makeEntry()])) as never);
    const resource = bindMemorySnapshotToResource(snapshot, 'docs/memory-snapshot.md');
    assert.equal(resource.id, 'memory.demo');
    assert.equal(resource.kind, 'document');
    assert.equal(resource.path, 'docs/memory-snapshot.md');
    assert.equal(resource.digest.hex, snapshot.snapshotDigest.hex);
    const bound = {
      ...contract,
      spec: { ...contract.spec, trustedContext: { ...contract.spec.trustedContext, resources: [resource] } },
    } as unknown as TaskContract;
    assert.equal(memorySnapshotBindingMatches(bound, snapshot), true);
    const drifted = { ...snapshot, snapshotDigest: hex('drift') };
    assert.equal(memorySnapshotBindingMatches(bound, drifted), false);
    assert.equal(memorySnapshotBindingMatches(contract, snapshot), false);
  });

  it('keeps derived resource ids within the core identifier bound', async () => {
    const store = await buildStore([makeEntry({ scope: { ...makeEntry().scope, taskpack: 'a'.repeat(120) } })]);
    const snapshot = selectActiveMemory(selectorInput(store) as never);
    const id = memorySnapshotResourceId(snapshot);
    assert.ok(id.length <= 64);
    assert.ok(/^memory\./.test(id));
  });
});

describe('memory path guards', () => {
  it('flags forbidden artifact names and managed paths', () => {
    assert.equal(forbiddenMemoryArtifactName('state.sqlite'), true);
    assert.equal(forbiddenMemoryArtifactName('run.json'), true);
    assert.equal(forbiddenMemoryArtifactName('privateSession.json'), true);
    assert.equal(forbiddenMemoryArtifactName('index.json'), false);
    assert.equal(isMemoryManagedPath('demo', '.loopwright/memory/demo/index.json'), true);
    assert.equal(isMemoryManagedPath('demo', '.loopwright/memory/demo'), true);
    assert.equal(isMemoryManagedPath('demo', '.loopwright/memory/other/index.json'), false);
    assert.equal(isMemoryManagedPath('demo', '.loopwright/memory/demo/../secret'), false);
    assert.equal(isMemoryManagedPath('demo', '/etc/passwd'), false);
    assert.equal(isMemoryManagedPath('Demo', '.loopwright/memory/Demo/index.json'), false);
  });
});

async function buildStore(entries: readonly MemoryEntry[], retired: readonly RetiredMemoryEntry[] = []): Promise<MemoryStoreIndex> {
  const base = { version: 1 as const, taskpack: 'demo', repository: 'org/repo', updatedAtMs: 1500, entries, retired };
  return { ...base, storeDigest: storeDigestOf(base) };
}
