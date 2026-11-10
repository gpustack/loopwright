import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defaultCorpusRoot, verifyFrozenCorpus } from '../src/corpus.js';
import {
  RUNNER_PARITY_SCENARIOS, buildParityFixtureRepository, buildParityReport, corpusDigestOf,
  legacyCase, normalizeLegacyStatus, runLegacyScenario, runRunnerParitySuite,
} from '../src/parity.js';
import { PythonBridge } from '../src/python-bridge.js';
import type { RunnerParityScenario } from '../src/parity.js';

const run = promisify(execFile);

describe('parity harness: legacy-side execution over the vendored frozen functions', () => {
  const bridge = new PythonBridge();
  const roots: string[] = [];
  after(async () => {
    await bridge.dispose();
    for (const root of roots) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  async function freshFixture(): Promise<{ repo: string; fake: string; headSha: string }> {
    const corpusRoot = defaultCorpusRoot();
    if (corpusRoot === null) throw new Error('vendored corpus absent');
    const fixture = await buildParityFixtureRepository();
    const fakeParent = await mkdtemp(join(await realpath(tmpdir()), 'parity-fake-'));
    const fake = join(fakeParent, 'repository');
    roots.push(fixture.path, fakeParent);
    await run('/usr/bin/git', ['clone', '-q', '--no-hardlinks', fixture.path, fake], { env: { HOME: fixture.path, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    return { repo: fixture.path, fake, headSha: fixture.headSha };
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

  it('runs no_update as a zero-write discovery with nothing to do', { timeout: 240000 }, async () => {
    const outcome = await legacy('no_update');
    assert.equal(outcome.status, 'no_changes', outcome.reason ?? '');
    assert.equal(outcome.prCount, 0);
    assert.equal(normalizeLegacyStatus(outcome.status), 'no_change');
  });

  it('publishes a single accepted group as exactly one managed pull request', { timeout: 240000 }, async () => {
    const outcome = await legacy('candidate_single_group');
    assert.equal(outcome.status, 'published', outcome.reason ?? '');
    assert.equal(outcome.prCount, 1);
    assert.ok(outcome.patchDigest !== null && outcome.patchDigest.length === 64);
  });

  it('publishes nothing when the drop-group mutation causes both groups to fail', { timeout: 240000 }, async () => {
    const outcome = await legacy('candidate_partial_groups');
    assert.equal(outcome.status, 'no_changes', `status was ${outcome.status}: ${outcome.reason ?? ''}`);
    assert.equal(outcome.prCount, 0);
  });

  it('blocks discovery when upstream acquisition fails and no update exists', { timeout: 240000 }, async () => {
    const outcome = await legacy('upstream_acquisition_failed');
    assert.equal(normalizeLegacyStatus(outcome.status), 'blocked', outcome.reason ?? '');
    assert.equal(outcome.prCount, 0);
  });

  it('converges on the existing managed pull request without duplicating it', { timeout: 240000 }, async () => {
    const outcome = await legacy('existing_managed_pr_convergence');
    assert.equal(outcome.prCount, 1, `status was ${outcome.status}: ${outcome.reason ?? ''}`);
    assert.equal(normalizeLegacyStatus(outcome.status), 'not_executed', outcome.reason ?? '');
  });

  it('accepts an authorized maintainer revision command against the managed pull request', { timeout: 240000 }, async () => {
    const outcome = await legacy('authorized_comment_revise');
    assert.equal(outcome.status, 'published', outcome.reason ?? '');
    assert.equal(outcome.prCount, 1, 'a revision must reuse the existing managed pull request');
    assert.equal(outcome.acceptedGroups, 1);
    assert.ok(outcome.patchDigest !== null && outcome.patchDigest.length === 64);
  });

  it('ignores a revision command when the author lacks repository write access', { timeout: 240000 }, async () => {
    const outcome = await legacy('unauthorized_comment_revise');
    assert.equal(outcome.status, 'ignored', outcome.reason ?? '');
    assert.match(outcome.reason ?? '', /lacks repository write permission/);
    assert.equal(outcome.prCount, 1);
    assert.equal(normalizeLegacyStatus(outcome.status), 'not_executed');
  });

  it('passes a sentinel-bearing comment on the legacy side, which Loopwright intake must improve on', { timeout: 240000 }, async () => {
    const outcome = await legacy('guidance_sentinel_injection');
    assert.equal(outcome.status, 'ready', outcome.reason ?? '');
    assert.equal(normalizeLegacyStatus(outcome.status), 'ready');
  });

  it('diagnoses pack run urls with the pinned 4000-character log bound', { timeout: 60000 }, async () => {
    const outcome = await legacy('pack_run_url_diagnosis');
    assert.equal(outcome.status, 'diagnosed');
    assert.equal(outcome.prCount, 0);
  });

  it('fails closed on a malformed or traversal draft with zero writes', { timeout: 240000 }, async () => {
    const outcome = await legacy('malformed_or_traversal_draft');
    assert.equal(normalizeLegacyStatus(outcome.status), 'blocked', outcome.reason ?? '');
    assert.equal(outcome.prCount, 0);
  });

  it('fails closed on a disallowed target path with zero writes', { timeout: 240000 }, async () => {
    const outcome = await legacy('disallowed_path_or_symlink_patch');
    assert.equal(normalizeLegacyStatus(outcome.status), 'blocked', outcome.reason ?? '');
    assert.equal(outcome.prCount, 0);
  });

  it('defers publication when the default branch moved during the run', { timeout: 240000 }, async () => {
    const outcome = await legacy('head_changed_before_publish');
    assert.equal(outcome.status, 'deferred', outcome.reason ?? '');
    assert.equal(outcome.prCount, 0);
    assert.match(outcome.reason ?? '', /Default branch changed/);
  });

  it('repairs a rejected candidate within one repair generation and publishes', { timeout: 240000 }, async () => {
    const outcome = await legacy('validation_feedback_repair');
    assert.equal(outcome.status, 'published', outcome.reason ?? '');
    assert.equal(outcome.prCount, 1);
    assert.match(outcome.reason ?? '', /one repair generation/);
  });

  it('adopts the landed pull request when a publication receipt was lost', { timeout: 240000 }, async () => {
    const outcome = await legacy('publication_receipt_lost_then_reconciled');
    assert.equal(outcome.prCount, 1, 'a rerun must never create a second managed pull request');
    assert.equal(normalizeLegacyStatus(outcome.status), 'not_executed', outcome.reason ?? '');
    assert.match(outcome.reason ?? '', /adopts landed state/);
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
    const report = await runRunnerParitySuite();
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
