import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultCorpusRoot, verifyFrozenCorpus } from '../src/corpus.js';
import {
  RUNNER_PARITY_SCENARIOS, buildParityFixtureRepository, buildParityReport, corpusDigestOf,
  legacyCase, normalizeLegacyStatus, runLegacyScenario, runRunnerParitySuite,
} from '../src/parity.js';
import { PythonBridge } from '../src/python-bridge.js';
import type { RunnerParityReport, RunnerParityScenario } from '../src/parity.js';

const run = promisify(execFile);

let sharedParityReportPromise: Promise<RunnerParityReport> | null = null;
function getSharedParityReport(): Promise<RunnerParityReport> {
  sharedParityReportPromise ??= runRunnerParitySuite();
  return sharedParityReportPromise;
}

describe('parity harness: legacy-side execution over the vendored frozen functions', () => {
  const bridge = new PythonBridge();
  const roots: string[] = [];
  let templateFixture: { path: string; headSha: string } | null = null;
  let tmpReal = '';
  before(async () => {
    await bridge.preflight();
    tmpReal = await realpath(tmpdir());
    templateFixture = await buildParityFixtureRepository();
    roots.push(templateFixture.path);
  });
  after(async () => {
    await bridge.dispose();
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)));
  });

  async function freshFixture(): Promise<{ repo: string; fake: string; headSha: string }> {
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null || templateFixture === null) throw new Error('vendored corpus absent');
    const parent = await mkdtemp(join(tmpReal, 'parity-fake-'));
    const repo = join(parent, 'source');
    const fake = join(parent, 'repository');
    roots.push(parent);
    await cp(templateFixture.path, repo, { recursive: true });
    await run('/usr/bin/git', ['clone', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-q', '--no-hardlinks', repo, fake], { env: { HOME: repo, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    return { repo, fake, headSha: templateFixture.headSha };
  }

  async function legacy(scenario: RunnerParityScenario): Promise<Awaited<ReturnType<typeof runLegacyScenario>>> {
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await freshFixture();
    return await runLegacyScenario({ bridge, corpusRoot, scenario, fixtureRepo: fixture.repo, fakeRepoDir: fixture.fake });
  }

  it('covers every specification scenario in order', () => {
    assert.equal(RUNNER_PARITY_SCENARIOS.length, 14);
    assert.deepEqual([...RUNNER_PARITY_SCENARIOS][0], 'no_update');
    assert.deepEqual([...RUNNER_PARITY_SCENARIOS][13], 'publication_receipt_lost_then_reconciled');
  });

  it('runs no_update directly via runLegacyScenario as a zero-write discovery with nothing to do', { timeout: 240000 }, async () => {
    const outcome = await legacy('no_update');
    assert.equal(outcome.status, 'no_changes', outcome.reason ?? '');
    assert.equal(outcome.prCount, 0);
    assert.equal(normalizeLegacyStatus(outcome.status), 'no_change');
  });

  it('verifies every frozen legacy disposition across all 14 scenarios from the shared parity suite', { timeout: 560000 }, async () => {
    const report = await getSharedParityReport();
    const byScenario = new Map(report.cases.map(c => [c.scenario, c]));

    const noUpdate = byScenario.get('no_update')!;
    assert.equal(noUpdate.legacyStatus, 'no_changes', noUpdate.legacyReason ?? '');
    assert.equal(noUpdate.legacyRemoteWrites, 0);
    assert.equal(noUpdate.legacyNormalized, 'no_change');

    const single = byScenario.get('candidate_single_group')!;
    assert.equal(single.legacyStatus, 'published', single.legacyReason ?? '');
    assert.equal(single.legacyRemoteWrites, 1);
    assert.equal(single.legacyAcceptedGroups, 1);
    assert.ok(single.legacyPatchDigest !== null && single.legacyPatchDigest !== undefined && single.legacyPatchDigest.length === 64);

    const partial = byScenario.get('candidate_partial_groups')!;
    assert.equal(partial.legacyStatus, 'published', `status was ${partial.legacyStatus}: ${partial.legacyReason ?? ''}`);
    assert.equal(partial.legacyRemoteWrites, 1);
    assert.equal(partial.legacyAcceptedGroups, 1);

    const acqFail = byScenario.get('upstream_acquisition_failed')!;
    assert.equal(acqFail.legacyNormalized, 'blocked', acqFail.legacyReason ?? '');
    assert.equal(acqFail.legacyRemoteWrites, 0);

    const converge = byScenario.get('existing_managed_pr_convergence')!;
    assert.equal(converge.legacyRemoteWrites, 1, `status was ${converge.legacyStatus}: ${converge.legacyReason ?? ''}`);
    assert.equal(converge.legacyNormalized, 'not_executed', converge.legacyReason ?? '');

    const authRevise = byScenario.get('authorized_comment_revise')!;
    assert.equal(authRevise.legacyStatus, 'published', authRevise.legacyReason ?? '');
    assert.equal(authRevise.legacyRemoteWrites, 1, 'a revision must reuse the existing managed pull request');
    assert.equal(authRevise.legacyAcceptedGroups, 1);
    assert.ok(authRevise.legacyPatchDigest !== null && authRevise.legacyPatchDigest !== undefined && authRevise.legacyPatchDigest.length === 64);

    const unauthRevise = byScenario.get('unauthorized_comment_revise')!;
    assert.equal(unauthRevise.legacyStatus, 'ignored', unauthRevise.legacyReason ?? '');
    assert.match(unauthRevise.legacyReason ?? '', /lacks repository write permission/);
    assert.equal(unauthRevise.legacyRemoteWrites, 1);
    assert.equal(unauthRevise.legacyNormalized, 'not_executed');

    const sentinel = byScenario.get('guidance_sentinel_injection')!;
    assert.equal(sentinel.legacyStatus, 'ready', sentinel.legacyReason ?? '');
    assert.equal(sentinel.legacyNormalized, 'ready');

    const packRun = byScenario.get('pack_run_url_diagnosis')!;
    assert.equal(packRun.legacyStatus, 'diagnosed');
    assert.equal(packRun.legacyRemoteWrites, 0);

    const traversal = byScenario.get('malformed_or_traversal_draft')!;
    assert.equal(traversal.legacyNormalized, 'blocked', traversal.legacyReason ?? '');
    assert.equal(traversal.legacyRemoteWrites, 0);

    const disallowed = byScenario.get('disallowed_path_or_symlink_patch')!;
    assert.equal(disallowed.legacyNormalized, 'blocked', disallowed.legacyReason ?? '');
    assert.equal(disallowed.legacyRemoteWrites, 0);

    const headChanged = byScenario.get('head_changed_before_publish')!;
    assert.equal(headChanged.legacyStatus, 'deferred', headChanged.legacyReason ?? '');
    assert.equal(headChanged.legacyRemoteWrites, 0);
    assert.match(headChanged.legacyReason ?? '', /Default branch changed/);

    const valRepair = byScenario.get('validation_feedback_repair')!;
    assert.equal(valRepair.legacyStatus, 'published', valRepair.legacyReason ?? '');
    assert.equal(valRepair.legacyRemoteWrites, 1);
    assert.match(valRepair.legacyReason ?? '', /one repair generation/);

    const lostReceipt = byScenario.get('publication_receipt_lost_then_reconciled')!;
    assert.equal(lostReceipt.legacyRemoteWrites, 1, 'a rerun must never create a second managed pull request');
    assert.equal(lostReceipt.legacyNormalized, 'not_executed', lostReceipt.legacyReason ?? '');
    assert.match(lostReceipt.legacyReason ?? '', /adopts landed state/);
  });

  it('assembles the report skeleton with correct summary arithmetic', async () => {
    const cases = [
      legacyCase('no_update', { status: 'no_changes', reason: null, prCount: 0, acceptedGroups: null, patchDigest: null, prNumbers: [] }, 'exact_match', 'discovery finds nothing on both sides'),
      legacyCase('guidance_sentinel_injection', { status: 'ready', reason: null, prCount: 1, acceptedGroups: null, patchDigest: null, prNumbers: [1] }, 'intentional_improvement', 'legacy passes sentinels; Loopwright intake blocks them before any model call'),
    ];
    const verification = await verifyFrozenCorpus();
    const report = buildParityReport(verification.manifest.sourceRevision, verification.corpusDigest, cases);
    assert.equal(report.version, 1);
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.exactMatch, 1);
    assert.equal(report.summary.intentionalImprovement, 1);
    assert.equal(report.summary.mismatch, 0);
    assert.match(report.corpusDigest, /^[0-9a-f]{64}$/);
    assert.equal(report.sourceRevision, '9b422c8bdbd31414ada7df8c4b55070b04957f44');
    assert.equal(cases[0]!.legacyNormalized, 'no_change');
    assert.equal(cases[1]!.remoteWrites, 1);
    const digest = corpusDigestOf(await readFile(join(defaultCorpusRoot()!, 'manifest.json')));
    assert.equal(digest, verification.corpusDigest);
  });
});

describe('parity harness: full 14-scenario suite on both sides', () => {
  it('matches legacy dispositions across every scenario with honest classifications', { timeout: 560000 }, async () => {
    const report = await getSharedParityReport();
    assert.equal(report.summary.total, 14);
    const byScenario = new Map(report.cases.map(c => [c.scenario, c]));
    const expectExact = [
      'no_update', 'candidate_single_group', 'candidate_partial_groups', 'upstream_acquisition_failed',
      'existing_managed_pr_convergence', 'authorized_comment_revise', 'pack_run_url_diagnosis',
      'malformed_or_traversal_draft', 'disallowed_path_or_symlink_patch', 'head_changed_before_publish',
      'validation_feedback_repair', 'publication_receipt_lost_then_reconciled',
    ] as const;
    for (const scenario of expectExact) {
      const c = byScenario.get(scenario);
      assert.ok(c !== undefined, `${scenario} missing from report`);
      assert.equal(c.classification, 'exact_match', `${scenario}: ${c.classification} — ${c.explanation}`);
    }
    for (const scenario of ['unauthorized_comment_revise', 'guidance_sentinel_injection'] as const) {
      const c = byScenario.get(scenario);
      assert.ok(c !== undefined, `${scenario} missing from report`);
      assert.equal(c.classification, 'intentional_improvement', `${scenario}: ${c.classification} — ${c.explanation}`);
    }
    assert.equal(byScenario.get('candidate_single_group')?.remoteWrites, 1);
    assert.equal(byScenario.get('no_update')?.remoteWrites, 0);
    assert.equal(byScenario.get('existing_managed_pr_convergence')?.remoteWrites, 1);
    assert.equal(byScenario.get('head_changed_before_publish')?.remoteWrites, 0);
    assert.equal(byScenario.get('candidate_single_group')?.acceptedGroupsMatch, true);
    assert.equal(byScenario.get('candidate_single_group')?.patchDigestMatch, true);
    assert.equal(byScenario.get('authorized_comment_revise')?.loopwrightOutcome, 'published');
    assert.equal(byScenario.get('authorized_comment_revise')?.remoteWrites, 1);
    assert.equal(byScenario.get('authorized_comment_revise')?.acceptedGroupsMatch, true);
    assert.equal(byScenario.get('authorized_comment_revise')?.patchDigestMatch, true);
    assert.equal(report.summary.mismatch + report.summary.exactMatch + report.summary.intentionalImprovement, 14);
    assert.equal(report.summary.mismatch, 0);
    assert.equal(report.summary.exactMatch, 12);
    assert.equal(report.summary.intentionalImprovement, 2);
    assert.equal(byScenario.get('publication_receipt_lost_then_reconciled')?.remoteWrites, 1);
    assert.equal(byScenario.get('publication_receipt_lost_then_reconciled')?.classification, 'exact_match');
  });
});
