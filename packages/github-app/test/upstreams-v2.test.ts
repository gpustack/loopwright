import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GitHubAppError, type TaskpackV2Manifest } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import {
  applyUpstreamGroups,
  attachUpstreamContext,
  buildUpstreamMemoryVersions,
  checkManagedPrMatchesDiscoveredState,
  discoverTaskpackUpstreams,
  discoverTaskpackUpstreamsV2,
  evaluateUpstreamIntakeDisposition,
  extractJsonVersionPath,
  formatUpstreamSummary,
  parseUpstreamRecordsJson,
  type UpstreamAcquisitionRecord,
} from '../src/upstreams.js';

async function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr === 'object');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function makeV2Manifest(options: {
  readonly upstreams: readonly Record<string, unknown>[];
  readonly upstreamGroups?: readonly Record<string, unknown>[];
  readonly proposal?: Record<string, unknown>;
}): TaskpackV2Manifest {
  return validateTaskpackV2Manifest({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'upstreams-v2-demo' },
    spec: {
      goal: { candidate: 'Sync upstreams', noChange: 'Verify' },
      scope: { writable: ['docs/**'], protected: [] },
      upstreams: options.upstreams,
      ...(options.upstreamGroups !== undefined ? { upstreamGroups: options.upstreamGroups } : {}),
      ...(options.proposal !== undefined ? { proposal: options.proposal } : {}),
      verification: {
        localChecks: [],
        externalGates: [],
      },
      publication: {
        mode: 'disabled',
        targetBranch: 'main',
        headBranchPrefix: 'sync/',
        titleTemplate: 'sync',
      },
      memory: {
        directory: '.loopwright/memory/upstreams-v2-demo',
        apply: 'disabled',
      },
      triggers: {
        schedule: false,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: [],
      },
    },
  } as unknown as Json);
}

describe('upstreams.ts: http-json versionPath dot & bracket traversal', () => {
  it('traverses dot, root $, numeric array index, and quoted bracket selectors safely', () => {
    const payload = {
      'dist-tags': { latest: '2.4.1' },
      data: {
        releases: [
          { version: 'v3.0.0' },
          { version: 'v2.9.0' },
        ],
      },
      packages: {
        '@scope/pkg': { version: '1.8.2' },
      },
    };

    assert.equal(extractJsonVersionPath(payload, 'dist-tags.latest'), '2.4.1');
    assert.equal(extractJsonVersionPath(payload, '$.data.releases[0].version'), 'v3.0.0');
    assert.equal(extractJsonVersionPath(payload, "packages['@scope/pkg'].version"), '1.8.2');
    assert.equal(extractJsonVersionPath(payload, '$["dist-tags"]["latest"]'), '2.4.1');
    assert.equal(extractJsonVersionPath(payload, '$.data.releases[99].version'), undefined);
    assert.equal(extractJsonVersionPath(payload, 'nonexistent.field'), undefined);
  });

  it('rejects __proto__, constructor, and prototype segments in dot and bracket notation', () => {
    const payload = { a: { b: '1.0.0' } };
    for (const bad of [
      '__proto__.polluted',
      'a.__proto__',
      'constructor.prototype',
      "a['__proto__']",
      'a["constructor"]',
      '$.prototype.x',
    ]) {
      assert.throws(
        () => extractJsonVersionPath(payload, bad),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
    }
  });

  it('discovers http-json upstreams using versionPath selectors', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/npm') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '4.2.0' } }));
        return;
      }
      if (req.url === '/scoped') {
        res.end(JSON.stringify({ packages: { '@scope/pkg': { version: '1.2.3' } } }));
        return;
      }
      if (req.url === '/missing') {
        res.end(JSON.stringify({ other: 'value' }));
        return;
      }
      res.end('{}');
    });

    try {
      const manifest = makeV2Manifest({
        upstreams: [
          {
            id: 'npm-pkg',
            kind: 'http-json',
            source: `${server.url}/npm`,
            watchedPaths: ['package.json'],
            versionPath: 'dist-tags.latest',
          },
          {
            id: 'scoped-pkg',
            kind: 'http-json',
            source: `${server.url}/scoped`,
            watchedPaths: ['packages/core/package.json'],
            versionPath: "packages['@scope/pkg'].version",
          },
          {
            id: 'missing-path',
            kind: 'http-json',
            source: `${server.url}/missing`,
            watchedPaths: ['docs'],
            versionPath: '$.data.releases[0].version',
          },
        ],
      });

      const discovered = await discoverTaskpackUpstreams(manifest, { includeMetadata: true });
      assert.equal(discovered[0]?.status, 'available');
      assert.equal(discovered[0]?.version, '4.2.0');
      assert.deepEqual(discovered[0]?.watchedPaths, ['package.json']);

      assert.equal(discovered[1]?.status, 'available');
      assert.equal(discovered[1]?.version, '1.2.3');
      assert.deepEqual(discovered[1]?.watchedPaths, ['packages/core/package.json']);

      assert.equal(discovered[2]?.status, 'failed');
      assert.match(discovered[2]?.reason ?? '', /versionPath/);
    } finally {
      await server.close();
    }
  });
});

describe('upstreams.ts: monotonicSemver downgrade protection & watchedPaths', () => {
  it('resolves lower fetched SemVer as held_back by default and allows override with monotonicSemver: false', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/downgrade-default') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '1.4.0' } }));
        return;
      }
      if (req.url === '/downgrade-prerelease') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '2.0.0-rc.1' } }));
        return;
      }
      if (req.url === '/downgrade-allowed') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '1.4.0' } }));
        return;
      }
      if (req.url === '/upgrade') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '1.6.0' } }));
        return;
      }
      res.end('{}');
    });

    try {
      const manifest = makeV2Manifest({
        upstreams: [
          {
            id: 'pkg-default',
            kind: 'http-json',
            source: `${server.url}/downgrade-default`,
            watchedPaths: ['package.json'],
            versionPath: 'dist-tags.latest',
          },
          {
            id: 'pkg-pre',
            kind: 'http-json',
            source: `${server.url}/downgrade-prerelease`,
            watchedPaths: ['package.json'],
            versionPath: 'dist-tags.latest',
          },
          {
            id: 'pkg-allow-down',
            kind: 'http-json',
            source: `${server.url}/downgrade-allowed`,
            watchedPaths: ['package.json'],
            versionPath: 'dist-tags.latest',
            monotonicSemver: false,
          },
          {
            id: 'pkg-up',
            kind: 'http-json',
            source: `${server.url}/upgrade`,
            watchedPaths: ['docs/versions.md'],
            versionPath: 'dist-tags.latest',
          },
        ],
      });

      const result = await discoverTaskpackUpstreamsV2(manifest, {
        baselineVersions: {
          'pkg-default': '1.5.0',
          'pkg-pre': '2.0.0',
          'pkg-allow-down': '1.5.0',
          'pkg-up': '1.5.0',
        },
      });

      const [rDefault, rPre, rAllow, rUp] = result.records;
      assert.equal(rDefault?.status, 'held_back');
      assert.equal(rDefault?.currentVersion, '1.5.0');
      assert.equal(rDefault?.version, '1.5.0');
      assert.equal(rDefault?.targetVersion, '1.4.0');
      assert.match(rDefault?.reason ?? '', /downgrade/i);
      assert.deepEqual(rDefault?.watchedPaths, ['package.json']);

      assert.equal(rPre?.status, 'held_back');
      assert.equal(rPre?.currentVersion, '2.0.0');
      assert.equal(rPre?.version, '2.0.0');
      assert.equal(rPre?.targetVersion, '2.0.0-rc.1');

      assert.equal(rAllow?.status, 'available');
      assert.equal(rAllow?.version, '1.4.0');

      assert.equal(rUp?.status, 'available');
      assert.equal(rUp?.version, '1.6.0');
      assert.deepEqual(rUp?.watchedPaths, ['docs/versions.md']);

      // Memory versions preserve currentVersion for held_back (NEVER skipped 1.4.0 or 2.0.0-rc.1)
      assert.equal(result.memoryVersions['pkg-default'], '1.5.0');
      assert.equal(result.memoryVersions['pkg-pre'], '2.0.0');
      assert.equal(result.memoryVersions['pkg-up'], '1.6.0');

      // Overall disposition proceeds as candidate despite held_back siblings
      assert.equal(result.disposition, 'candidate');

      // Summary includes held_back records and watchedPaths
      assert.match(result.summary, /pkg-default/);
      assert.match(result.summary, /held_back/);
      assert.match(result.summary, /docs\/versions\.md/);
    } finally {
      await server.close();
    }
  });
});

describe('upstreams.ts: atomic lockstep upstreamGroups & held_back disposition', () => {
  it('holds back entire lockstep group atomically when members disagree while sibling independent upstream proceeds as candidate', () => {
    const records: readonly UpstreamAcquisitionRecord[] = [
      { upstreamId: 'pi-ai', status: 'available', version: '0.62.0', currentVersion: '0.61.0', watchedPaths: ['package.json'] },
      { upstreamId: 'pi-coding', status: 'available', version: '0.61.5', currentVersion: '0.61.0', watchedPaths: ['package.json'] },
      { upstreamId: 'yaml-lib', status: 'available', version: '2.9.2', currentVersion: '2.9.1', watchedPaths: ['packages/github-app/package.json'] },
    ];
    const groups = [
      { id: 'pi-suite', members: ['pi-ai', 'pi-coding'], policy: 'lockstep' as const },
      { id: 'misc', members: ['yaml-lib'], policy: 'independent' as const },
    ];

    const grouped = applyUpstreamGroups(records, groups);
    const piAi = grouped.find(r => r.upstreamId === 'pi-ai');
    const piCoding = grouped.find(r => r.upstreamId === 'pi-coding');
    const yamlLib = grouped.find(r => r.upstreamId === 'yaml-lib');

    assert.equal(piAi?.status, 'held_back');
    assert.equal(piAi?.currentVersion, '0.61.0');
    assert.equal(piAi?.version, '0.61.0');
    assert.equal(piAi?.targetVersion, '0.62.0');
    assert.equal(piAi?.groupId, 'pi-suite');
    assert.match(piAi?.reason ?? '', /pi-suite/);

    assert.equal(piCoding?.status, 'held_back');
    assert.equal(piCoding?.currentVersion, '0.61.0');
    assert.equal(piCoding?.version, '0.61.0');
    assert.equal(piCoding?.targetVersion, '0.61.5');
    assert.equal(piCoding?.groupId, 'pi-suite');

    // Sibling independent upstream stays available!
    assert.equal(yamlLib?.status, 'available');
    assert.equal(yamlLib?.version, '2.9.2');

    // Overall disposition stays candidate!
    const evalRes = evaluateUpstreamIntakeDisposition(grouped);
    assert.equal(evalRes.disposition, 'candidate');
    assert.equal(evalRes.available.length, 1);
    assert.equal(evalRes.heldBack.length, 2);

    // Reviewed memory keeps currentVersion for held_back members
    const mem = buildUpstreamMemoryVersions(grouped);
    assert.equal(mem['pi-ai'], '0.61.0');
    assert.equal(mem['pi-coding'], '0.61.0');
    assert.equal(mem['yaml-lib'], '2.9.2');
  });

  it('holds back entire lockstep group when one member fails/holds back, preserving failure provenance as blocked vs held_back no_change', () => {
    const groups = [{ id: 'core-lockstep', members: ['a', 'b'], policy: 'lockstep' as const }];

    // 1) Underlying acquisition failure (HTTP 503) with zero available siblings MUST resolve as 'blocked' (not masked as 'no_change')!
    const withFailure: readonly UpstreamAcquisitionRecord[] = [
      { upstreamId: 'a', status: 'available', version: '2.0.0', currentVersion: '1.0.0' },
      { upstreamId: 'b', status: 'failed', currentVersion: '1.0.0', reason: 'HTTP 503' },
      { upstreamId: 'c', status: 'up_to_date', version: '3.0.0', currentVersion: '3.0.0' },
    ];
    const groupedFailed = applyUpstreamGroups(withFailure, groups);
    assert.equal(groupedFailed[0]?.status, 'held_back');
    assert.equal(groupedFailed[0]?.version, '1.0.0');
    assert.equal(groupedFailed[1]?.status, 'held_back');
    assert.equal(groupedFailed[1]?.version, '1.0.0');
    assert.equal(groupedFailed[1]?.underlyingStatus, 'failed');
    assert.equal(groupedFailed[2]?.status, 'up_to_date');

    const evalBlocked = evaluateUpstreamIntakeDisposition(groupedFailed);
    assert.equal(evalBlocked.disposition, 'blocked');
    assert.equal(evalBlocked.failures.length, 1);
    assert.match(evalBlocked.reason, /HTTP 503/);

    // 2) Non-failure held_back (e.g. monotonicSemver downgrade) with zero available siblings yields clean 'no_change'
    const withHeldBackOnly: readonly UpstreamAcquisitionRecord[] = [
      { upstreamId: 'a', status: 'available', version: '2.0.0', currentVersion: '1.0.0' },
      { upstreamId: 'b', status: 'held_back', version: '1.0.0', currentVersion: '1.0.0', targetVersion: '0.9.0', reason: 'downgrade prevented' },
      { upstreamId: 'c', status: 'up_to_date', version: '3.0.0', currentVersion: '3.0.0' },
    ];
    const groupedHeld = applyUpstreamGroups(withHeldBackOnly, groups);
    const evalNoChange = evaluateUpstreamIntakeDisposition(groupedHeld);
    assert.equal(evalNoChange.disposition, 'no_change');
    assert.match(evalNoChange.reason, /held_back/i);

    // 3) Unrelated available sibling still proceeds as 'candidate' even when lockstep group failed!
    const withAvailableSibling = applyUpstreamGroups([
      ...withFailure,
      { upstreamId: 'd', status: 'available', version: '4.0.0', currentVersion: '3.0.0' },
    ], groups);
    const evalCandidate = evaluateUpstreamIntakeDisposition(withAvailableSibling);
    assert.equal(evalCandidate.disposition, 'candidate');
  });

  it('allows lockstep group to proceed atomically when all members agree on target version or stay up_to_date and stamps groupId on all group members', () => {
    const groups = [
      { id: 'pi-suite', members: ['pi-ai', 'pi-coding'], policy: 'lockstep' as const },
      { id: 'indep', members: ['yaml-lib'], policy: 'independent' as const },
    ];

    const allAvailableSame = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'available', version: '0.62.0', currentVersion: '0.61.0' },
      { upstreamId: 'pi-coding', status: 'available', version: '0.62.0', currentVersion: '0.61.0' },
      { upstreamId: 'yaml-lib', status: 'available', version: '2.9.2', currentVersion: '2.9.1' },
    ], groups);
    assert.equal(allAvailableSame[0]?.status, 'available');
    assert.equal(allAvailableSame[0]?.groupId, 'pi-suite');
    assert.equal(allAvailableSame[1]?.status, 'available');
    assert.equal(allAvailableSame[1]?.groupId, 'pi-suite');
    assert.equal(allAvailableSame[2]?.groupId, 'indep');

    const partialSameTarget = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'available', version: '0.62.0', currentVersion: '0.61.0' },
      { upstreamId: 'pi-coding', status: 'up_to_date', version: '0.62.0', currentVersion: '0.62.0' },
    ], groups);
    assert.equal(partialSameTarget[0]?.status, 'available');
    assert.equal(partialSameTarget[0]?.groupId, 'pi-suite');
    assert.equal(partialSameTarget[1]?.status, 'up_to_date');
    assert.equal(partialSameTarget[1]?.groupId, 'pi-suite');

    const allUpToDate = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'up_to_date', version: '0.61.0', currentVersion: '0.61.0' },
      { upstreamId: 'pi-coding', status: 'up_to_date', version: '0.61.0', currentVersion: '0.61.0' },
    ], groups);
    assert.equal(allUpToDate[0]?.status, 'up_to_date');
    assert.equal(allUpToDate[0]?.groupId, 'pi-suite');
    assert.equal(allUpToDate[1]?.status, 'up_to_date');
    assert.equal(allUpToDate[1]?.groupId, 'pi-suite');
  });

  it('accepts held_back status in parseUpstreamRecordsJson and attaches watchedPaths in summary helpers', () => {
    const parsed = parseUpstreamRecordsJson(JSON.stringify([
      { upstreamId: 'pi-ai', status: 'held_back', version: '0.62.0', currentVersion: '0.61.0', reason: 'lockstep mismatch' },
    ]));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.status, 'held_back');
    assert.equal(parsed[0]?.version, '0.61.0');
    assert.equal(parsed[0]?.currentVersion, '0.61.0');
    assert.equal(parsed[0]?.targetVersion, '0.62.0');

    const enriched = attachUpstreamContext(parsed, [
      { id: 'pi-ai', kind: 'http-json', source: 'https://registry.npmjs.org/pi-ai', watchedPaths: ['package.json', 'packages/agent-pi/package.json'] },
    ]);
    assert.deepEqual(enriched[0]?.watchedPaths, ['package.json', 'packages/agent-pi/package.json']);
    const summary = formatUpstreamSummary(enriched);
    assert.match(summary, /packages\/agent-pi\/package\.json/);
    assert.match(summary, /held_back/);
  });
});

describe('upstreams.ts: proposal-optional baseline version resolution', () => {
  it('resolves baselines from package.json or falls back to null baseline cleanly when spec.proposal is omitted', async () => {
    const work = await mkdtemp(join(tmpdir(), 'loopwright-upstreams-noproposal-'));
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/yaml') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '2.9.1' } }));
        return;
      }
      if (req.url === '/unknown-pkg') {
        res.end(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }));
        return;
      }
      res.end('{}');
    });

    try {
      const repoWithPkg = join(work, 'repo-with-pkg');
      const repoEmpty = join(work, 'repo-empty');
      await mkdir(repoWithPkg, { recursive: true });
      await mkdir(repoEmpty, { recursive: true });
      await writeFile(
        join(repoWithPkg, 'package.json'),
        JSON.stringify({
          name: 'demo',
          dependencies: { yaml: '^2.9.1' },
        }),
        'utf8',
      );

      const manifest = makeV2Manifest({
        upstreams: [
          {
            id: 'yaml',
            kind: 'http-json',
            source: `${server.url}/yaml`,
            watchedPaths: ['package.json'],
            versionPath: 'dist-tags.latest',
          },
          {
            id: 'unlisted',
            kind: 'http-json',
            source: `${server.url}/unknown-pkg`,
            watchedPaths: ['docs'],
            versionPath: 'dist-tags.latest',
          },
        ],
      });
      assert.equal(manifest.spec.proposal, undefined);

      // 1) Repo with package.json matches yaml=2.9.1 as up_to_date and unlisted as available
      const resWithPkg = await discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoWithPkg });
      assert.equal(resWithPkg.records[0]?.status, 'up_to_date');
      assert.equal(resWithPkg.records[0]?.currentVersion, '2.9.1');
      assert.equal(resWithPkg.records[1]?.status, 'available');
      assert.equal(resWithPkg.records[1]?.currentVersion, undefined);
      assert.equal(resWithPkg.records[1]?.version, '1.0.0');

      // 2) Repo without package.json or proposal falls back cleanly to null/no baseline without crashing
      const resEmpty = await discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoEmpty });
      assert.equal(resEmpty.records[0]?.status, 'available');
      assert.equal(resEmpty.records[0]?.version, '2.9.1');
      assert.equal(resEmpty.records[1]?.status, 'available');

      // 3) checkManagedPrMatchesDiscoveredState returns false cleanly when spec.proposal is omitted
      const matched = await checkManagedPrMatchesDiscoveredState({
        repositoryRoot: repoEmpty,
        repositoryFullName: 'acme/demo',
        manifest,
        openManagedPr: {
          number: 1,
          htmlUrl: 'https://github.com/acme/demo/pull/1',
          headRef: 'sync/1',
          headSha: 'a'.repeat(40),
          baseRef: 'main',
          baseSha: 'b'.repeat(40),
          title: 'sync',
          body: null,
        },
        records: resEmpty.records,
      });
      assert.equal(matched, false);
    } finally {
      await server.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});

describe('upstreams.ts: Review-T7 security & edge-case hardening regressions', () => {
  it('fails closed on symlinked or malformed baseline package.json / proposal.json instead of swallowing errors', async () => {
    const work = await mkdtemp(join(tmpdir(), 'loopwright-upstreams-baseline-err-'));
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0' }));
    });
    try {
      const outside = join(work, 'outside');
      const repoSymlink = join(work, 'repo-symlink');
      const repoMalformed = join(work, 'repo-malformed');
      await mkdir(outside, { recursive: true });
      await mkdir(repoSymlink, { recursive: true });
      await mkdir(repoMalformed, { recursive: true });

      const secretFile = join(outside, 'secret.json');
      await writeFile(secretFile, JSON.stringify({ dependencies: { pkg: '2.0.0' } }), 'utf8');
      await symlink(secretFile, join(repoSymlink, 'package.json'));
      await writeFile(join(repoMalformed, 'package.json'), '{ not valid json', 'utf8');

      const manifest = makeV2Manifest({
        upstreams: [{ id: 'pkg', kind: 'http-json', source: `${server.url}/pkg`, watchedPaths: ['package.json'] }],
      });

      await assert.rejects(
        discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoSymlink }),
        (err: unknown) => err instanceof GitHubAppError && (err.code === 'ACTION_INPUT_INVALID' || err.code === 'TASKPACK_SCOPE_VIOLATION'),
      );
      await assert.rejects(
        discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoMalformed }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
      );
    } finally {
      await server.close();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rejects non-loopback http://, credentials, fragments, and disallowed schemes for http-json upstreams', async () => {
    let fetched = false;
    const fetchImpl: typeof globalThis.fetch = async () => {
      fetched = true;
      return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    };

    const manifest = makeV2Manifest({
      upstreams: [
        { id: 'plain-http', kind: 'http-json', source: 'http://example.com/v.json', watchedPaths: ['docs'] },
        { id: 'with-creds', kind: 'http-json', source: 'https://user:pass@example.com/v.json', watchedPaths: ['docs'] },
        { id: 'with-frag', kind: 'http-json', source: 'https://example.com/v.json#frag', watchedPaths: ['docs'] },
        { id: 'bad-scheme', kind: 'http-json', source: 'file:///etc/passwd', watchedPaths: ['docs'] },
      ],
    });

    const records = await discoverTaskpackUpstreams(manifest, { fetchImpl });
    assert.equal(fetched, false);
    for (const rec of records) {
      assert.equal(rec.status, 'failed');
    }
    assert.match(records[0]?.reason ?? '', /https:\/\//i);
    assert.match(records[1]?.reason ?? '', /credential/i);
    assert.match(records[2]?.reason ?? '', /fragment/i);
    assert.match(records[3]?.reason ?? '', /https:\/\//i);
  });

  it('reports blocked (not no_change) when all lockstep http-json endpoints fail with HTTP 503 and preserves per-member details', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `outage on ${req.url ?? ''}` }));
    });
    try {
      const manifest = makeV2Manifest({
        upstreams: [
          { id: 'pkg-a', kind: 'http-json', source: `${server.url}/a`, watchedPaths: ['package.json'] },
          { id: 'pkg-b', kind: 'http-json', source: `${server.url}/b`, watchedPaths: ['package.json'] },
        ],
        upstreamGroups: [
          { id: 'suite', members: ['pkg-a', 'pkg-b'], policy: 'lockstep' },
        ],
      });
      const result = await discoverTaskpackUpstreamsV2(manifest);
      assert.equal(result.disposition, 'blocked');
      assert.equal(result.records[0]?.status, 'held_back');
      assert.equal(result.records[0]?.underlyingStatus, 'failed');
      assert.equal(result.records[1]?.status, 'held_back');
      assert.equal(result.records[1]?.underlyingStatus, 'failed');
      assert.match(result.records[0]?.reason ?? '', /pkg-a/);
      assert.match(result.records[0]?.reason ?? '', /pkg-b/);
    } finally {
      await server.close();
    }
  });

  it('hardens parseUpstreamRecordsJson (nested __proto__, duplicate keys, multiline/empty versions), extractJsonVersionPath bounds, and package.json comparator specs', async () => {
    // 1) Nested __proto__ and duplicate JSON keys rejected
    assert.throws(
      () => parseUpstreamRecordsJson('[{"upstreamId":"u1","status":"available","version":"1.0.0","metadata":{"nested":{"__proto__":{"bad":1}}}}]'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
    );
    assert.throws(
      () => parseUpstreamRecordsJson('[{"upstreamId":"u1","status":"available","status":"up_to_date","version":"1.0.0"}]'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
    );
    assert.throws(
      () => parseUpstreamRecordsJson('[{"upstreamId":"u1","status":"available","version":"1.0.0\\nfake: line"}]'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
    );
    assert.throws(
      () => parseUpstreamRecordsJson('[{"upstreamId":"u1","status":"available","version":""}]'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
    );

    // 2) extractJsonVersionPath rejects multiline or >256-char version strings
    assert.throws(
      () => extractJsonVersionPath({ version: '1.0.0\ninjected' }, 'version'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
    );
    assert.throws(
      () => extractJsonVersionPath({ version: 'v'.repeat(257) }, 'version'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
    );

    // 3) formatUpstreamSummary sanitizes newlines in reasons
    const summary = formatUpstreamSummary([{ upstreamId: 'u1', status: 'failed', reason: 'line1\nline2\r\nline3' }]);
    assert.equal(summary.split('\n').length, 1);

    // 4) package.json comparator (>=2.0.0) and protocol (link:, catalog:) specs are ignored instead of passed through as invalid baselines, and upstreamRecordsJson path forwards repo baselines
    const work = await mkdtemp(join(tmpdir(), 'loopwright-upstreams-pkg-cmp-'));
    const server = await startMockServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0' }));
    });
    try {
      await writeFile(
        join(work, 'package.json'),
        JSON.stringify({
          dependencies: {
            'pkg-cmp': '>=2.0.0',
            'pkg-proto': 'catalog:default',
            'pkg-pin': '^1.5.0',
          },
        }),
        'utf8',
      );
      const manifest = makeV2Manifest({
        upstreams: [
          { id: 'pkg-cmp', kind: 'http-json', source: `${server.url}/a`, watchedPaths: ['package.json'] },
          { id: 'pkg-proto', kind: 'http-json', source: `${server.url}/b`, watchedPaths: ['package.json'] },
          { id: 'pkg-pin', kind: 'http-json', source: `${server.url}/c`, watchedPaths: ['package.json'] },
        ],
        upstreamGroups: [
          { id: 'pin-group', members: ['pkg-pin', 'pkg-cmp'], policy: 'lockstep' },
        ],
      });
      const res = await discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: work });
      assert.equal(res.records[0]?.currentVersion, undefined);
      assert.equal(res.records[1]?.currentVersion, undefined);
      assert.equal(res.records[2]?.currentVersion, '1.5.0');

      // upstreamRecordsJson path forwards repository package.json baselines into applyUpstreamGroups!
      const fromJson = await discoverTaskpackUpstreams(manifest, {
        repositoryRoot: work,
        upstreamRecordsJson: JSON.stringify([
          { upstreamId: 'pkg-pin', status: 'available', version: '2.0.0' },
          { upstreamId: 'pkg-cmp', status: 'available', version: '1.9.0' },
        ]),
      });
      assert.equal(fromJson[0]?.status, 'held_back');
      assert.equal(fromJson[0]?.currentVersion, '1.5.0');
      assert.equal(fromJson[0]?.version, '1.5.0');
    } finally {
      await server.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
