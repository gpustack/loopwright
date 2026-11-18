import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyMemoryProposalCAS,
  loadMemoryStore,
  memoryDirectoryFor,
  memoryProposalSchema,
  type MemoryCASInput,
  type MemoryEntry,
  type MemoryOperation,
  type MemoryProposal,
} from '../src/index.js';
import { buildMemoryPullRequestBody, buildMemoryPullRequestTitle } from '../src/cas.js';
import { BASE_REVISION, buildRun, hex, inventoryMap, type RunFixture } from './run-fixtures.js';

const CONVENTIONAL_COMMIT_REGEX = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w\-./]+\))?(!)?: .+/;

function makeEntry(fixture: RunFixture, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    version: 1,
    id: 'entry.one',
    claimKey: 'claim.one',
    claim: 'Verified claim for check one.',
    kind: 'fact',
    scope: { taskpack: 'demo', repository: 'org/repo', paths: ['src/**'], targetMatrix: null },
    sourceRef: {
      runId: 'run.fixture.one',
      lockHash: fixture.lock.spec.lockHash,
      candidateDigest: fixture.result.spec.subject.candidateDigest,
    },
    sourceDigest: hex('source'),
    verifiedAtMs: 1500,
    validFor: {
      baseRevision: BASE_REVISION,
      sourceRevision: 'c'.repeat(40),
      codeFingerprint: hex('fingerprint'),
      upstreamVersions: { npm: '1.0.0' },
    },
    expiresAtMs: 99_999,
    supersedes: [],
    evidenceRefs: [{
      evidenceId: 'evidence.check.one',
      checkId: 'check.one',
      level: 'local_execution',
      observedStatus: 'passed',
      artifact: fixture.artifactRefs[1]!,
    }],
    ...overrides,
  };
}

function makeProposal(fixture: RunFixture, operations: readonly MemoryOperation[], baseDigest = hex('base-store')): MemoryProposal {
  return memoryProposalSchema({
    version: 1,
    proposalId: 'proposal.run.fixture.one.abcd',
    taskpack: 'demo',
    repository: 'org/repo',
    baseRevision: BASE_REVISION,
    baseStoreDigest: baseDigest,
    createdAtMs: 1500,
    runId: 'run.fixture.one',
    lockHash: fixture.lock.spec.lockHash,
    operations,
  }, '/proposal');
}

describe('memory PR title and Markdown body formatting', () => {
  it('formats Conventional Commit titles for upsert, retire, mixed, and long taskpack names within 72 chars', async () => {
    const fixture = await buildRun('completed');
    const entry = makeEntry(fixture);
    const upsertOne = [{ kind: 'upsert', entry }] as const;
    const upsertTwo = [{ kind: 'upsert', entry }, { kind: 'upsert', entry }] as const;
    const retireOne = [{ kind: 'retire', entryId: 'entry.old', reason: 'stale' }] as const;
    const retireThree = [
      { kind: 'retire', entryId: 'entry.a', reason: 'stale' },
      { kind: 'retire', entryId: 'entry.b', reason: 'stale' },
      { kind: 'retire', entryId: 'entry.c', reason: 'stale' },
    ] as const;
    const mixed = [...upsertTwo, ...retireOne] as const;

    const t1 = buildMemoryPullRequestTitle({ taskpack: 'auto-sync', operations: upsertOne });
    assert.equal(t1, 'chore(memory): record 1 verified auto-sync entry');
    assert.match(t1, CONVENTIONAL_COMMIT_REGEX);

    const t2 = buildMemoryPullRequestTitle({ taskpack: 'auto-sync', operations: upsertTwo });
    assert.equal(t2, 'chore(memory): record 2 verified auto-sync entries');
    assert.match(t2, CONVENTIONAL_COMMIT_REGEX);

    const t3 = buildMemoryPullRequestTitle({ taskpack: 'auto-sync', operations: retireOne });
    assert.equal(t3, 'chore(memory): retire 1 stale auto-sync entry');
    assert.match(t3, CONVENTIONAL_COMMIT_REGEX);

    const t4 = buildMemoryPullRequestTitle({ taskpack: 'auto-sync', operations: retireThree });
    assert.equal(t4, 'chore(memory): retire 3 stale auto-sync entries');
    assert.match(t4, CONVENTIONAL_COMMIT_REGEX);

    const t5 = buildMemoryPullRequestTitle({ taskpack: 'auto-sync', operations: mixed });
    assert.equal(t5, 'chore(memory): update auto-sync memory (+2 / -1)');
    assert.match(t5, CONVENTIONAL_COMMIT_REGEX);

    const tLong = buildMemoryPullRequestTitle({
      taskpack: 'extremely-long-taskpack-identifier-exceeding-twenty-eight-chars\n\t',
      operations: upsertTwo,
    });
    assert.ok(Array.from(tLong).length <= 72, `expected <= 72 chars, got ${Array.from(tLong).length}: ${tLong}`);
    assert.match(tLong, CONVENTIONAL_COMMIT_REGEX);
    assert.equal(/[\r\n]/.test(tLong), false);
  });

  it('renders structured Markdown body with escaped table cells, Supersede/Record/Retire actions, and <details> provenance', async () => {
    const fixture = await buildRun('completed');
    const recorded = makeEntry(fixture, {
      id: 'entry.record',
      claimKey: 'claim.record',
      claim: 'Build uses CUDA 12.6 | verified\\path\non linux.',
    });
    const superseded = makeEntry(fixture, {
      id: 'entry.super',
      claimKey: 'claim.super',
      claim: 'New invariant claim.',
      kind: 'invariant',
      supersedes: ['entry.old'],
      evidenceRefs: [
        {
          evidenceId: 'ev.1',
          checkId: 'proposal-ledger',
          level: 'local_execution',
          observedStatus: 'passed',
          artifact: fixture.artifactRefs[1]!,
        },
        {
          evidenceId: 'ev.2',
          checkId: 'proposal-ledger',
          level: 'local_execution',
          observedStatus: 'passed',
          artifact: fixture.artifactRefs[1]!,
        },
        {
          evidenceId: 'ev.3',
          checkId: 'verify-build',
          level: 'local_execution',
          observedStatus: 'passed',
          artifact: fixture.artifactRefs[0]!,
        },
      ],
    });
    const proposal = makeProposal(fixture, [
      { kind: 'upsert', entry: recorded },
      { kind: 'upsert', entry: superseded },
      { kind: 'retire', entryId: 'entry.old', reason: 'Retired | obsolete\\rule' },
    ]);

    const body = buildMemoryPullRequestBody({
      taskpack: 'demo',
      proposal,
      storeDigestBefore: hex('before'),
      storeDigestAfter: hex('after'),
    });

    assert.ok(body.includes('## Summary'));
    assert.ok(body.includes('Updates reviewed memory for taskpack `demo` from verified run `run.fixture.one` (2 recorded, 1 retired).'));
    assert.ok(body.includes('| Action | Kind | Entry | Claim / Reason | Evidence |'));
    assert.ok(body.includes('| Record | `fact` | `claim.record` | Build uses CUDA 12.6 \\| verified\\\\path on linux. | `check.one` |'));
    assert.ok(body.includes('| Supersede | `invariant` | `claim.super` | New invariant claim. | `proposal-ledger`, `verify-build` |'));
    assert.ok(body.includes('| Retire | - | `entry.old` | Retired \\| obsolete\\\\rule | - |'));
    assert.ok(body.includes('<details>'));
    assert.ok(body.includes('<summary>Provenance & Evidence Receipts (2)</summary>'));
    assert.ok(body.includes(`- **Proposal ID**: \`${proposal.proposalId}\``));
    assert.ok(body.includes(`- **Base Revision**: \`${BASE_REVISION.slice(0, 12)}\` (\`${BASE_REVISION}\`)`));
    assert.ok(body.includes(`- **Store Digest**: \`${hex('before').hex.slice(0, 12)}\` -> \`${hex('after').hex.slice(0, 12)}\``));
    assert.ok(body.includes(`- \`evidence-one.bin\` (\`sha256:${fixture.artifactRefs[1]!.digest.hex.slice(0, 16)}…\`)`));
    assert.ok(body.includes('</details>'));

    // Also verify fallback to entry.id when claimKey is empty
    const emptyClaimKeyProposal: MemoryProposal = {
      ...proposal,
      operations: [{ kind: 'upsert', entry: { ...superseded, claimKey: '' } }],
    };
    const fallbackBody = buildMemoryPullRequestBody({
      taskpack: 'demo',
      proposal: emptyClaimKeyProposal,
      storeDigestBefore: hex('before'),
      storeDigestAfter: hex('after'),
    });
    assert.ok(fallbackBody.includes('| Supersede | `invariant` | `entry.super` |'));
  });

  it('bounds table rows at 50 and empty cited artifacts cleanly, and applyMemoryProposalCAS emits the formatted PR spec', async () => {
    const fixture = await buildRun('completed');
    const manyOps: MemoryOperation[] = [];
    for (let i = 0; i < 55; i += 1) {
      manyOps.push({ kind: 'retire', entryId: `entry.${i}`, reason: `reason ${i}` });
    }
    const proposal = makeProposal(fixture, manyOps);
    const boundedBody = buildMemoryPullRequestBody({
      taskpack: 'demo',
      proposal,
      storeDigestBefore: hex('before'),
      storeDigestAfter: hex('after'),
    });
    assert.ok(boundedBody.includes('_...and 5 additional operation(s)._'));
    assert.ok(boundedBody.includes('<summary>Provenance & Evidence Receipts (0)</summary>'));
    assert.ok(boundedBody.includes('- **Cited Artifacts**: none'));
    assert.ok(Array.from(boundedBody).length <= 30_000);

    // Escapes < and > as &lt; and &gt; in Claim / Reason prose cells
    const angleEntry = makeEntry(fixture, {
      id: 'entry.angles',
      claimKey: 'claim.angles',
      claim: 'Use Array<string> without <script> or <details> injection.',
    });
    const angleProposal = makeProposal(fixture, [{ kind: 'upsert', entry: angleEntry }]);
    const angleBody = buildMemoryPullRequestBody({
      taskpack: 'demo',
      proposal: angleProposal,
      storeDigestBefore: hex('before'),
      storeDigestAfter: hex('after'),
    });
    assert.ok(
      angleBody.includes('Use Array&lt;string&gt; without &lt;script&gt; or &lt;details&gt; injection.'),
      angleBody,
    );

    // High-volume proposal (50 upserts x 200-char claims x 10 evidenceRefs) stays <= 30,000 code points
    // and preserves the complete closed <details> Provenance & Evidence Receipts block.
    const heavyOps: MemoryOperation[] = [];
    const heavyClaim = 'C'.repeat(200);
    for (let i = 0; i < 50; i += 1) {
      const refs = Array.from({ length: 10 }, (_, j) => ({
        evidenceId: `evidence.check.${i}.${j}`,
        checkId: `check.long.identifier.${i}.${j}`,
        level: 'local_execution' as const,
        observedStatus: 'passed' as const,
        artifact: {
          name: `artifacts/output-${i}-${j}-${'x'.repeat(60)}.json`,
          digest: hex(`artifact-${i}-${j}`),
          byteLength: 128,
        },
      }));
      heavyOps.push({
        kind: 'upsert',
        entry: makeEntry(fixture, {
          id: `entry.heavy.${i}`,
          claimKey: `claim.heavy.${'k'.repeat(40)}.${i}`,
          claim: heavyClaim,
          evidenceRefs: refs,
        }),
      });
    }
    const heavyProposal = makeProposal(fixture, heavyOps);
    const heavyBody = buildMemoryPullRequestBody({
      taskpack: 'demo',
      proposal: heavyProposal,
      storeDigestBefore: hex('before'),
      storeDigestAfter: hex('after'),
    });
    assert.ok(Array.from(heavyBody).length <= 30_000, `expected <= 30000, got ${Array.from(heavyBody).length}`);
    assert.match(heavyBody, /_\.\.\.and \d+ additional operation\(s\)\._/);
    assert.ok(heavyBody.includes('<details>\n<summary>Provenance & Evidence Receipts (500)</summary>'), heavyBody);
    assert.ok(heavyBody.includes('</details>'), heavyBody);
    assert.ok(heavyBody.endsWith('</details>'), heavyBody);

    const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-mem-pr-fmt-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      const baseIndex = (await loadMemoryStore(root, 'demo', 'org/repo')).index;
      const entry = makeEntry(fixture);
      const casProposal = makeProposal(fixture, [{ kind: 'upsert', entry }], baseIndex.storeDigest);
      const casInput: MemoryCASInput = {
        repository: root,
        taskpack: 'demo',
        proposal: casProposal,
        lock: fixture.lock,
        result: fixture.result,
        incident: null,
        evidence: fixture.evidence,
        artifacts: inventoryMap(fixture),
        candidateDigest: fixture.result.spec.subject.candidateDigest,
        secretValues: [],
        memoryWritable: [memoryDirectoryFor('demo')],
        protectedPaths: [],
        targetBranch: 'main',
        currentRevision: BASE_REVISION,
        baseStore: baseIndex,
        allowRebase: true,
        nowMs: 1500,
      };
      const casResult = await applyMemoryProposalCAS(casInput);
      assert.equal(casResult.applied, true);
      assert.equal(casResult.pullRequest!.title, 'chore(memory): record 1 verified demo entry');
      assert.ok(casResult.pullRequest!.body.includes('## Memory Changes'));
      assert.ok(casResult.pullRequest!.body.includes('| Record | `fact` | `claim.one` |'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('neutralizes trailing backslashes in inline code spans and bounds baseRevision to 64 code points', async () => {
    const fixture = await buildRun('completed');
    const entry = makeEntry(fixture, {
      evidenceRefs: [{
        evidenceId: 'ev.backslash',
        checkId: 'check.backslash',
        level: 'local_execution',
        observedStatus: 'passed',
        artifact: {
          ...fixture.artifactRefs[1]!,
          name: 'artifacts\\nested\\file`name\\',
        },
      }],
    });
    const longBaseRevision = `${'a'.repeat(80)}\\`;
    const proposal: MemoryProposal = {
      ...makeProposal(fixture, [{ kind: 'upsert', entry }]),
      proposalId: 'prop\\id\\',
      runId: 'run\\id\\',
      baseRevision: longBaseRevision,
    };

    const body = buildMemoryPullRequestBody({
      taskpack: 'pack\\name\\',
      proposal,
      storeDigestBefore: hex('before'),
      storeDigestAfter: hex('after'),
    });

    assert.ok(
      body.includes('Updates reviewed memory for taskpack `pack/name/` from verified run `run/id/`'),
      body,
    );
    assert.ok(body.includes('- **Proposal ID**: `prop/id/`'), body);
    assert.ok(body.includes('- **Run ID**: `run/id/`'), body);
    assert.ok(body.includes(`- **Base Revision**: \`${'a'.repeat(12)}\` (\`${'a'.repeat(64)}\`)`), body);
    assert.equal(body.includes('a'.repeat(65)), false, 'baseRevision full span must be bounded to 64 code points');
    assert.ok(body.includes("- `artifacts/nested/file'name/`"), body);
    assert.equal(/\\`/.test(body), false, 'inline code spans must not end with an unescaped backslash');
  });
});
