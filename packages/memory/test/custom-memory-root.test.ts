import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TaskContract } from '@loopwright/core';
import * as memoryPublicApi from '../src/index.js';
import {
  applyMemoryProposalCAS,
  bindMemorySnapshotToResource,
  computeCodeFingerprint,
  ensureMemoryDirectories,
  finalizeRunMemory,
  isMemoryManagedPath,
  loadMemoryStore,
  MEMORY_ROOT,
  memoryDirectoryFor,
  memorySnapshotResourceId,
  normalizeMemoryRoot,
  selectActiveMemory,
  verifyMemoryProposal,
} from '../src/index.js';
import { ensureSafeDirectoryChain } from '../src/store.js';
import { BASE_REVISION, buildRun, CONTRACT, inventoryMap, SOURCE_REVISION } from './run-fixtures.js';

async function withSandbox(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-custom-mem-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('custom memoryRoot support and backward compatibility', () => {
  it('validates normalizeMemoryRoot, memoryDirectoryFor, and isMemoryManagedPath with backward-compatible defaults', () => {
    assert.equal(normalizeMemoryRoot(), MEMORY_ROOT);
    assert.equal(normalizeMemoryRoot('.auto-sync/memory'), '.auto-sync/memory');
    assert.equal(memoryDirectoryFor('demo'), '.loopwright/memory/demo');
    assert.equal(memoryDirectoryFor('auto-sync', '.auto-sync/memory'), '.auto-sync/memory/auto-sync');

    assert.equal(isMemoryManagedPath('auto-sync', '.auto-sync/memory/auto-sync/index.json', '.auto-sync/memory'), true);
    assert.equal(isMemoryManagedPath('auto-sync', '.auto-sync/memory/auto-sync/entries/entry.alpha.md', '.auto-sync/memory'), true);
    assert.equal(isMemoryManagedPath('auto-sync', '.loopwright/memory/auto-sync/index.json', '.auto-sync/memory'), false);
    assert.equal(isMemoryManagedPath('auto-sync', '.auto-sync/memory/other/index.json', '.auto-sync/memory'), false);
    assert.equal(isMemoryManagedPath('auto-sync', '.auto-sync/taskpack.yaml', '.auto-sync/memory'), false);

    for (const invalid of [
      '',
      '/abs/memory',
      'trailing/',
      'back\\slash',
      '.',
      '..',
      '.auto-sync/../memory',
      '.auto-sync/./memory',
      '.auto-sync//memory',
      'trailing-dot./memory',
      '.git',
      '.git/memory',
      '.github',
      '.github/memory',
      '.auto-sync/.github',
      'CON/memory',
      'has space/memory',
      'bad\u0000char',
      'a'.repeat(257),
    ]) {
      assert.throws(() => normalizeMemoryRoot(invalid), /MEMORY_PATH_ESCAPED|memoryRoot/, `expected "${invalid}" to fail`);
    }
  });

  it('trims trailing punctuation on sliced memorySnapshotResourceId', () => {
    for (const sep of ['-', '.', '_']) {
      // `memory.` prefix is 7 chars; limit is 64 -> suffix slice is 57 chars.
      // 56 'a' chars + punctuation at index 56 places punctuation right on the 57-char cut!
      const id = memorySnapshotResourceId({
        version: 1,
        taskpack: `${'a'.repeat(56)}${sep}extra`,
        repository: 'org/repo',
        evaluatedAtMs: 0,
        activeEntries: [],
        excludedEntries: [],
        renderedMarkdown: '',
        snapshotDigest: { algorithm: 'sha256', hex: 'f'.repeat(64) },
      });
      assert.equal(id, `memory.${'a'.repeat(56)}`);
      assert.match(id, /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/);
      assert.ok(id.length <= 64);
    }
  });

  it('refuses symlinks on every path component from repository down to custom memoryRoot/<taskpack>/entries', async () => {
    // 1. Symlink at first custom root segment (`.auto-sync`)
    await withSandbox(async root => {
      const outside = join(root, 'outside');
      const repo = join(root, 'repo');
      await mkdir(outside, { recursive: true });
      await mkdir(repo, { recursive: true });
      await symlink(outside, join(repo, '.auto-sync'));
      await assert.rejects(() => loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/memory'), /symbolic link/);
      await assert.rejects(() => ensureMemoryDirectories(repo, 'demo', '.auto-sync/memory'), /symbolic link/);
    });

    // 2. Symlink at second custom root segment (`.auto-sync/memory`)
    await withSandbox(async root => {
      const outside = join(root, 'outside');
      const repo = join(root, 'repo');
      await mkdir(outside, { recursive: true });
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await symlink(outside, join(repo, '.auto-sync', 'memory'));
      await assert.rejects(() => loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/memory'), /symbolic link/);
      await assert.rejects(() => ensureMemoryDirectories(repo, 'demo', '.auto-sync/memory'), /symbolic link/);
    });

    // 3. Symlink at taskpack directory (`.auto-sync/memory/demo`)
    await withSandbox(async root => {
      const outside = join(root, 'outside');
      const repo = join(root, 'repo');
      await mkdir(outside, { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'memory'), { recursive: true });
      await symlink(outside, join(repo, '.auto-sync', 'memory', 'demo'));
      await assert.rejects(() => loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/memory'), /symbolic link/);
      await assert.rejects(() => ensureMemoryDirectories(repo, 'demo', '.auto-sync/memory'), /symbolic link/);
    });

    // 4. Symlink at `entries` directory (`.auto-sync/memory/demo/entries`)
    await withSandbox(async root => {
      const outside = join(root, 'outside');
      const repo = join(root, 'repo');
      await mkdir(outside, { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'memory', 'demo'), { recursive: true });
      await symlink(outside, join(repo, '.auto-sync', 'memory', 'demo', 'entries'));
      await assert.rejects(() => ensureMemoryDirectories(repo, 'demo', '.auto-sync/memory'), /symbolic link/);
    });
  });

  it('round-trips finalizeRunMemory -> verifyMemoryProposal -> applyMemoryProposalCAS -> selectActiveMemory under .auto-sync/memory without self-invalidating codeFingerprint', async () => {
    await withSandbox(async repo => {
      await mkdir(join(repo, '.git'), { recursive: true });
      await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"2.0.0"}\n', 'utf8');
      await mkdir(join(repo, '.auto-sync'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), 'kind: Taskpack\n', 'utf8');

      const autoSyncContract: TaskContract = {
        ...CONTRACT,
        spec: {
          ...CONTRACT.spec,
          taskpack: 'auto-sync',
          scope: {
            writable: ['**'],
            protected: ['.github/**', '.auto-sync/**', '.auto-sync/memory/**'],
          },
        },
      };

      const run1 = await buildRun('completed', 'run-autosync-1', autoSyncContract);
      const finalized1 = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: repo,
          summary: {
            lock: run1.lock,
            result: run1.result,
            incident: null,
            ledger: { revision: 1, remainingTokens: 500, remainingModelCalls: 2, remainingWallMs: 10_000 },
            candidateManifest: run1.manifest.spec.entries,
            observations: [],
            evidence: run1.evidence,
            artifacts: run1.artifactRefs,
          },
        },
        config: {
          taskpack: 'auto-sync',
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          onNoModelBudget: 'deterministic-observations-only',
          curator: null,
          requireCuratorReview: false,
          nowMs: 10_000,
          ttlMs: 86_400_000,
          upstreamVersions: { engine: '2.0.0' },
        },
      });

      assert.equal(finalized1.status, 'proposed');
      assert.ok(finalized1.proposal !== null);
      assert.equal(finalized1.proposal.operations.length, 1);

      const baseStore = (await loadMemoryStore(repo, 'auto-sync', 'org/repo', '.auto-sync/memory')).index;
      const verified = await verifyMemoryProposal({
        proposal: finalized1.proposal,
        store: baseStore,
        lock: run1.lock,
        result: run1.result,
        incident: null,
        evidence: run1.evidence,
        artifacts: inventoryMap(run1),
        candidateDigest: run1.result.spec.subject.candidateDigest,
        patch: finalized1.patch ?? '',
        secretValues: ['super-secret-value-xyz'],
        memoryRoot: '.auto-sync/memory',
        memoryWritable: ['.auto-sync/memory'],
        protectedPaths: ['.github/**', '.auto-sync/taskpack.yaml'],
        exemptContractProtectedPatterns: ['.auto-sync/**', '.auto-sync/memory/**'],
      });
      assert.equal(verified.satisfied, true, JSON.stringify(verified.gates));

      const cas1 = await applyMemoryProposalCAS({
        repository: repo,
        taskpack: 'auto-sync',
        proposal: finalized1.proposal,
        lock: run1.lock,
        result: run1.result,
        incident: null,
        evidence: run1.evidence,
        artifacts: inventoryMap(run1),
        candidateDigest: run1.result.spec.subject.candidateDigest,
        secretValues: ['super-secret-value-xyz'],
        memoryRoot: '.auto-sync/memory',
        memoryWritable: ['.auto-sync/memory'],
        protectedPaths: ['.github/**', '.auto-sync/taskpack.yaml'],
        exemptContractProtectedPatterns: ['.auto-sync/**', '.auto-sync/memory/**'],
        targetBranch: 'main',
        currentRevision: BASE_REVISION,
        baseStore,
        allowRebase: true,
        nowMs: 10_000,
      });
      assert.equal(cas1.applied, true, JSON.stringify(cas1.refusal));
      assert.ok(cas1.pullRequest !== null);
      assert.equal(cas1.pullRequest.excludesCodeCandidatePaths, true);
      assert.ok(cas1.pullRequest.modifiedFiles.every(f => f.path.startsWith('.auto-sync/memory/auto-sync/')));

      // Mutate `.git/HEAD` and keep `.auto-sync/memory/auto-sync/**` written on disk:
      // computeCodeFingerprint must ignore `.git` and excludedPaths so active memory remains valid!
      await writeFile(join(repo, '.git', 'HEAD'), `${'d'.repeat(40)}\n`, 'utf8');
      const loadedAfter = await loadMemoryStore(repo, 'auto-sync', 'org/repo', '.auto-sync/memory');
      assert.equal(loadedAfter.index.entries.length, 1);

      const currentFingerprint = await computeCodeFingerprint(
        repo,
        autoSyncContract.spec.scope.writable,
        '.auto-sync/memory',
      );
      const snapshot = selectActiveMemory({
        store: loadedAfter.index,
        contract: autoSyncContract,
        nowMs: 12_000,
        currentCodeFingerprint: currentFingerprint,
        currentUpstreamVersions: { engine: '2.0.0' },
        targetCell: null,
      });
      assert.equal(snapshot.activeEntries.length, 1, `unexpected exclusions: ${JSON.stringify(snapshot.excludedEntries)}`);
      const resource = bindMemorySnapshotToResource(snapshot, '.auto-sync/memory/auto-sync/active-snapshot.md');
      assert.equal(resource.kind, 'document');
      assert.equal(resource.path, '.auto-sync/memory/auto-sync/active-snapshot.md');

      // Rebase test on custom memoryRoot: second contract check produces disjoint claimKey while store already moved.
      const secondCheckContract: TaskContract = {
        ...autoSyncContract,
        spec: {
          ...autoSyncContract.spec,
          acceptance: {
            required: ['check.two'],
            checks: [{ id: 'check.two', allowedEvidenceLevels: ['local_execution'] }],
          },
        },
      };
      // Build proposal against empty baseStore, then apply with rebase onto loadedAfter (`cas1` store) and new HEAD.
      const tempEmptyRepo = join(repo, '..', `empty-${Date.now()}`);
      await mkdir(join(tempEmptyRepo, 'pack'), { recursive: true });
      await writeFile(join(tempEmptyRepo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"2.0.0"}\n', 'utf8');
      await mkdir(join(tempEmptyRepo, '.auto-sync'), { recursive: true });
      await writeFile(join(tempEmptyRepo, '.auto-sync', 'taskpack.yaml'), 'kind: Taskpack\n', 'utf8');
      try {
        const emptyStore = (await loadMemoryStore(tempEmptyRepo, 'auto-sync', 'org/repo', '.auto-sync/memory')).index;
        const run2 = await buildRun('failed', 'run-autosync-2', secondCheckContract);
        const finalized2 = await finalizeRunMemory({
          context: {
            kind: 'summary',
            repository: tempEmptyRepo,
            summary: {
              lock: run2.lock,
              result: run2.result,
              incident: null,
              ledger: { revision: 1, remainingTokens: 0, remainingModelCalls: 0, remainingWallMs: 0 },
              candidateManifest: run2.manifest.spec.entries,
              observations: [],
              evidence: run2.evidence,
              artifacts: run2.artifactRefs,
            },
          },
          config: {
            taskpack: 'auto-sync',
            memoryRoot: '.auto-sync/memory',
            memoryWritable: ['.auto-sync/memory'],
            onNoModelBudget: 'deterministic-observations-only',
            curator: null,
            requireCuratorReview: false,
            nowMs: 15_000,
            ttlMs: 86_400_000,
            upstreamVersions: { engine: '2.0.0' },
          },
        });
        assert.ok(finalized2.proposal !== null);
        const cas2 = await applyMemoryProposalCAS({
          repository: repo,
          taskpack: 'auto-sync',
          proposal: finalized2.proposal,
          lock: run2.lock,
          result: run2.result,
          incident: null,
          evidence: run2.evidence,
          artifacts: inventoryMap(run2),
          candidateDigest: run2.result.spec.subject.candidateDigest,
          secretValues: [],
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          protectedPaths: ['.github/**', '.auto-sync/taskpack.yaml'],
          exemptContractProtectedPatterns: ['.auto-sync/**', '.auto-sync/memory/**'],
          targetBranch: 'main',
          currentRevision: SOURCE_REVISION,
          baseStore: emptyStore,
          allowRebase: true,
          nowMs: 15_000,
        });
        assert.equal(cas2.applied, true, JSON.stringify(cas2.refusal));
        assert.equal(cas2.rebased, true);
        const finalLoaded = await loadMemoryStore(repo, 'auto-sync', 'org/repo', '.auto-sync/memory');
        assert.equal(finalLoaded.index.entries.length, 2);
      } finally {
        await rm(tempEmptyRepo, { recursive: true, force: true });
      }
    });
  });

  it('honors onNoModelBudget: skip when model budget is exhausted or no curator is configured', async () => {
    await withSandbox(async repo => {
      const run = await buildRun('failed', 'run-skip-budget', CONTRACT);
      const outcome = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: repo,
          summary: {
            lock: run.lock,
            result: run.result,
            incident: null,
            ledger: { revision: 1, remainingTokens: 0, remainingModelCalls: 0, remainingWallMs: 0 },
            candidateManifest: run.manifest.spec.entries,
            observations: [],
            evidence: run.evidence,
            artifacts: run.artifactRefs,
          },
        },
        config: {
          taskpack: 'demo',
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          onNoModelBudget: 'skip',
          curator: null,
          requireCuratorReview: false,
          nowMs: 5_000,
          ttlMs: 86_400_000,
          upstreamVersions: {},
        },
      });
      assert.equal(outcome.status, 'pending');
      assert.equal(outcome.reason, 'no_model_budget_skipped');
      assert.equal(outcome.proposal, null);
      assert.deepEqual(outcome.deterministicEntries, []);
    });
  });

  it('rejects traversal in ensureSafeDirectoryChain and blocks case-aliased policy/protected roots', async () => {
    assert.equal('ensureSafeDirectoryChain' in memoryPublicApi, false, 'internal directory helper must not be re-exported publicly');
    assert.throws(() => normalizeMemoryRoot('.loopwright/policies'), /protected \.loopwright\/policies/);
    assert.throws(() => normalizeMemoryRoot('.loopwright/PoLiCiEs'), /protected \.loopwright\/policies/);
    assert.throws(() => normalizeMemoryRoot('.Loopwright/PoLiCiEs/sub'), /protected \.loopwright\/policies/);

    await withSandbox(async root => {
      const repo = join(root, 'repo');
      await mkdir(join(repo, '.loopwright', 'policies'), { recursive: true });
      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });

      await assert.rejects(() => ensureSafeDirectoryChain(repo, ['..', 'escaped']), /invalid path segment/);
      assert.equal(existsSync(join(root, 'escaped')), false, 'must never create directories outside repository');
      await assert.rejects(() => ensureSafeDirectoryChain(repo, ['.loopwright', 'PoLiCiEs', 'demo']), /protected \.loopwright\/policies/);
      await assert.rejects(() => ensureMemoryDirectories(repo, 'demo', '.auto-sync/ChEcKs'), /aliases existing entry/);
      await assert.rejects(() => loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/ChEcKs'), /aliases existing entry/);
      const autoSyncEntries = await import('node:fs/promises').then(fs => fs.readdir(join(repo, '.auto-sync')));
      assert.deepEqual(autoSyncEntries, ['checks'], 'case-aliased sibling must be rejected before creating directories');

      const run = await buildRun('completed', 'run-case-alias', CONTRACT);
      const validFinalized = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: repo,
          summary: {
            lock: run.lock,
            result: run.result,
            incident: null,
            ledger: { revision: 1, remainingTokens: 100, remainingModelCalls: 1, remainingWallMs: 5_000 },
            candidateManifest: run.manifest.spec.entries,
            observations: [],
            evidence: run.evidence,
            artifacts: run.artifactRefs,
          },
        },
        config: {
          taskpack: 'demo',
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          onNoModelBudget: 'deterministic-observations-only',
          curator: null,
          requireCuratorReview: false,
          nowMs: 10_000,
          ttlMs: 86_400_000,
          upstreamVersions: {},
        },
      });
      assert.ok(validFinalized.proposal !== null);
      const baseStore = (await loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/memory')).index;

      const caseAliasVerify = await verifyMemoryProposal({
        proposal: validFinalized.proposal,
        store: baseStore,
        lock: run.lock,
        result: run.result,
        incident: null,
        evidence: run.evidence,
        artifacts: inventoryMap(run),
        candidateDigest: run.result.spec.subject.candidateDigest,
        patch: validFinalized.patch ?? '',
        secretValues: [],
        memoryRoot: '.loopwright/PoLiCiEs',
        memoryWritable: ['.loopwright/PoLiCiEs'],
        protectedPaths: ['.github/**'],
      });
      assert.equal(caseAliasVerify.satisfied, false);
      assert.equal(caseAliasVerify.gates.find(g => g.gate === 'scope')?.status, 'failed');

      const protectedCaseAliasVerify = await verifyMemoryProposal({
        proposal: validFinalized.proposal,
        store: baseStore,
        lock: run.lock,
        result: run.result,
        incident: null,
        evidence: run.evidence,
        artifacts: inventoryMap(run),
        candidateDigest: run.result.spec.subject.candidateDigest,
        patch: validFinalized.patch ?? '',
        secretValues: [],
        memoryRoot: '.Auto-Sync/ChEcKs',
        memoryWritable: ['.Auto-Sync/ChEcKs'],
        protectedPaths: ['.auto-sync/checks', '.auto-sync/checks/**'],
      });
      assert.equal(protectedCaseAliasVerify.satisfied, false);
      assert.equal(protectedCaseAliasVerify.gates.find(g => g.gate === 'scope')?.status, 'failed');
    });
  });

  it('preserves >32 writable scope patterns without truncation so entry scope.paths matches codeFingerprint', async () => {
    await withSandbox(async repo => {
      const writablePatterns: string[] = ['src/**'];
      for (let idx = 1; idx <= 34; idx += 1) {
        const dirName = `mod-${String(idx).padStart(2, '0')}`;
        writablePatterns.push(`${dirName}/**`);
        await mkdir(join(repo, dirName), { recursive: true });
        await writeFile(join(repo, dirName, 'index.ts'), `export const v = ${idx};\n`, 'utf8');
      }
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'app.ts'), 'export const app = true;\n', 'utf8');
      assert.equal(writablePatterns.length, 35);

      const wideContract: TaskContract = {
        ...CONTRACT,
        spec: {
          ...CONTRACT.spec,
          scope: {
            writable: writablePatterns,
            protected: ['.github/**'],
          },
        },
      };
      const run = await buildRun('completed', 'run-wide-scope', wideContract);
      const finalized = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: repo,
          summary: {
            lock: run.lock,
            result: run.result,
            incident: null,
            ledger: { revision: 1, remainingTokens: 100, remainingModelCalls: 1, remainingWallMs: 5_000 },
            candidateManifest: run.manifest.spec.entries,
            observations: [],
            evidence: run.evidence,
            artifacts: run.artifactRefs,
          },
        },
        config: {
          taskpack: 'demo',
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          onNoModelBudget: 'deterministic-observations-only',
          curator: null,
          requireCuratorReview: false,
          nowMs: 12_000,
          ttlMs: 86_400_000,
          upstreamVersions: {},
        },
      });
      assert.equal(finalized.status, 'proposed');
      assert.ok(finalized.proposal !== null);
      const upserted = finalized.proposal.operations[0];
      assert.ok(upserted !== undefined && upserted.kind === 'upsert');
      assert.equal(upserted.entry.scope.paths.length, 35);

      const recomputedFromEntryPaths = await computeCodeFingerprint(
        repo,
        upserted.entry.scope.paths,
        '.auto-sync/memory',
      );
      assert.equal(recomputedFromEntryPaths.hex, upserted.entry.validFor.codeFingerprint.hex);

      const baseStore = (await loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/memory')).index;
      const cas = await applyMemoryProposalCAS({
        repository: repo,
        taskpack: 'demo',
        proposal: finalized.proposal,
        lock: run.lock,
        result: run.result,
        incident: null,
        evidence: run.evidence,
        artifacts: inventoryMap(run),
        candidateDigest: run.result.spec.subject.candidateDigest,
        secretValues: [],
        memoryRoot: '.auto-sync/memory',
        memoryWritable: ['.auto-sync/memory'],
        protectedPaths: ['.github/**'],
        targetBranch: 'main',
        currentRevision: BASE_REVISION,
        baseStore,
        allowRebase: true,
        nowMs: 12_000,
      });
      assert.equal(cas.applied, true, JSON.stringify(cas.refusal));
      const postStore = (await loadMemoryStore(repo, 'demo', 'org/repo', '.auto-sync/memory')).index;
      const active = selectActiveMemory({
        store: postStore,
        contract: wideContract,
        nowMs: 13_000,
        currentCodeFingerprint: recomputedFromEntryPaths,
        currentUpstreamVersions: {},
        targetCell: null,
      });
      assert.equal(active.activeEntries.length, 1);
    });
  });

  it('preserves two-argument computeCodeFingerprint compatibility when writable overlaps protected paths', async () => {
    await withSandbox(async repo => {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'src', 'index.ts'), 'export const ok = 1;\n', 'utf8');
      await writeFile(join(repo, 'src', 'protected.ts'), 'export const frozen = true;\n', 'utf8');

      const overlapContract: TaskContract = {
        ...CONTRACT,
        spec: {
          ...CONTRACT.spec,
          scope: {
            writable: ['src/**'],
            protected: ['src/protected.ts', '.github/**'],
          },
        },
      };
      const run = await buildRun('completed', 'run-fp-compat', overlapContract);
      const finalized = await finalizeRunMemory({
        context: {
          kind: 'summary',
          repository: repo,
          summary: {
            lock: run.lock,
            result: run.result,
            incident: null,
            ledger: { revision: 1, remainingTokens: 100, remainingModelCalls: 1, remainingWallMs: 5_000 },
            candidateManifest: run.manifest.spec.entries,
            observations: [],
            evidence: run.evidence,
            artifacts: run.artifactRefs,
          },
        },
        config: {
          taskpack: 'demo',
          memoryWritable: ['.loopwright/memory/demo'],
          onNoModelBudget: 'deterministic-observations-only',
          curator: null,
          requireCuratorReview: false,
          nowMs: 10_000,
          ttlMs: 86_400_000,
          upstreamVersions: {},
        },
      });
      assert.ok(finalized.proposal !== null);
      const baseStore = (await loadMemoryStore(repo, 'demo', 'org/repo')).index;
      const cas = await applyMemoryProposalCAS({
        repository: repo,
        taskpack: 'demo',
        proposal: finalized.proposal,
        lock: run.lock,
        result: run.result,
        incident: null,
        evidence: run.evidence,
        artifacts: inventoryMap(run),
        candidateDigest: run.result.spec.subject.candidateDigest,
        secretValues: [],
        memoryWritable: ['.loopwright/memory/demo'],
        protectedPaths: ['.github/**'],
        targetBranch: 'main',
        currentRevision: BASE_REVISION,
        baseStore,
        allowRebase: true,
        nowMs: 10_000,
      });
      assert.equal(cas.applied, true, JSON.stringify(cas.refusal));

      // Two-argument consumer call without protected exclusions must match producer fingerprint!
      const twoArgFingerprint = await computeCodeFingerprint(repo, overlapContract.spec.scope.writable);
      const loaded = await loadMemoryStore(repo, 'demo', 'org/repo');
      const snapshot = selectActiveMemory({
        store: loaded.index,
        contract: overlapContract,
        nowMs: 11_000,
        currentCodeFingerprint: twoArgFingerprint,
        currentUpstreamVersions: {},
        targetCell: null,
      });
      assert.equal(snapshot.activeEntries.length, 1, `expected 1 active entry, got exclusions: ${JSON.stringify(snapshot.excludedEntries)}`);
    });
  });

  it('supports valid POSIX taskpack identifiers like aux and con.examples across finalize, verify, CAS, and load', async () => {
    if (process.platform === 'win32') return;
    await withSandbox(async repo => {
      await mkdir(join(repo, 'pack'), { recursive: true });
      await writeFile(join(repo, 'pack', 'proposal.json'), '{"schema_version":1,"version":"2.0.0"}\n', 'utf8');
      for (const taskpackId of ['aux', 'con.examples']) {
        const tpContract: TaskContract = {
          ...CONTRACT,
          spec: {
            ...CONTRACT.spec,
            taskpack: taskpackId,
            scope: {
              writable: ['pack/**'],
              protected: ['.github/**', '.auto-sync/**'],
            },
          },
        };
        const run = await buildRun('completed', `run-${taskpackId.replace('.', '-')}`, tpContract);
        const finalized = await finalizeRunMemory({
          context: {
            kind: 'summary',
            repository: repo,
            summary: {
              lock: run.lock,
              result: run.result,
              incident: null,
              ledger: { revision: 1, remainingTokens: 500, remainingModelCalls: 2, remainingWallMs: 10_000 },
              candidateManifest: run.manifest.spec.entries,
              observations: [],
              evidence: run.evidence,
              artifacts: run.artifactRefs,
            },
          },
          config: {
            taskpack: taskpackId,
            memoryRoot: '.auto-sync/memory',
            memoryWritable: ['.auto-sync/memory'],
            onNoModelBudget: 'deterministic-observations-only',
            curator: null,
            requireCuratorReview: false,
            nowMs: 10_000,
            ttlMs: 86_400_000,
            upstreamVersions: {},
          },
        });
        assert.equal(finalized.status, 'proposed');
        assert.ok(finalized.proposal !== null);

        const baseStore = (await loadMemoryStore(repo, taskpackId, 'org/repo', '.auto-sync/memory')).index;
        const verified = await verifyMemoryProposal({
          proposal: finalized.proposal,
          store: baseStore,
          lock: run.lock,
          result: run.result,
          incident: null,
          evidence: run.evidence,
          artifacts: inventoryMap(run),
          candidateDigest: run.result.spec.subject.candidateDigest,
          patch: finalized.patch ?? '',
          secretValues: [],
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          protectedPaths: ['.github/**', '.auto-sync/taskpack.yaml'],
          exemptContractProtectedPatterns: ['.auto-sync/**'],
        });
        assert.equal(verified.satisfied, true, JSON.stringify(verified.gates));

        const cas = await applyMemoryProposalCAS({
          repository: repo,
          taskpack: taskpackId,
          proposal: finalized.proposal,
          lock: run.lock,
          result: run.result,
          incident: null,
          evidence: run.evidence,
          artifacts: inventoryMap(run),
          candidateDigest: run.result.spec.subject.candidateDigest,
          secretValues: [],
          memoryRoot: '.auto-sync/memory',
          memoryWritable: ['.auto-sync/memory'],
          protectedPaths: ['.github/**', '.auto-sync/taskpack.yaml'],
          exemptContractProtectedPatterns: ['.auto-sync/**'],
          targetBranch: 'main',
          currentRevision: BASE_REVISION,
          baseStore,
          allowRebase: true,
          nowMs: 10_000,
        });
        assert.equal(cas.applied, true, JSON.stringify(cas.refusal));
        const reloaded = await loadMemoryStore(repo, taskpackId, 'org/repo', '.auto-sync/memory');
        assert.equal(reloaded.index.entries.length, 1);
      }
    });
  });
});
