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
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function makeV2Manifest(options: {
  readonly upstreams: readonly Record<string, unknown>[];
  readonly upstreamGroups?: readonly Record<string, unknown>[];
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
      verification: { localChecks: [], externalGates: [] },
      publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'sync/', titleTemplate: 'sync' },
      memory: { directory: '.loopwright/memory/upstreams-v2-demo', apply: 'disabled' },
      triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] },
    },
  } as unknown as Json);
}

function expectInputError(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID');
}

describe('upstreams.ts: http-json versionPath, URL guards, and record parsing', () => {
  it('traverses dot/bracket versionPath selectors and rejects prototype pollution or oversized/multiline values', () => {
    const payload = {
      'dist-tags': { latest: '2.4.1' },
      data: { releases: [{ version: 'v3.0.0' }, { version: 'v2.9.0' }] },
      packages: { '@scope/pkg': { version: '1.8.2' } },
    };
    assert.equal(extractJsonVersionPath(payload, 'dist-tags.latest'), '2.4.1');
    assert.equal(extractJsonVersionPath(payload, '$.data.releases[0].version'), 'v3.0.0');
    assert.equal(extractJsonVersionPath(payload, "packages['@scope/pkg'].version"), '1.8.2');
    assert.equal(extractJsonVersionPath(payload, '$["dist-tags"]["latest"]'), '2.4.1');
    assert.equal(extractJsonVersionPath(payload, '$.data.releases[99].version'), undefined);

    for (const bad of ['__proto__.polluted', 'a.__proto__', 'constructor.prototype', "a['__proto__']", 'a["constructor"]', '$.prototype.x']) {
      expectInputError(() => extractJsonVersionPath(payload, bad));
    }
    expectInputError(() => extractJsonVersionPath({ version: '1.0.0\ninjected' }, 'version'));
    expectInputError(() => extractJsonVersionPath({ version: 'v'.repeat(257) }, 'version'));

    // parseUpstreamRecordsJson rejects nested __proto__, duplicate keys, multiline/empty versions; accepts held_back
    for (const badJson of [
      '[{"upstreamId":"u1","status":"available","version":"1.0.0","metadata":{"nested":{"__proto__":{"bad":1}}}}]',
      '[{"upstreamId":"u1","status":"available","status":"up_to_date","version":"1.0.0"}]',
      '[{"upstreamId":"u1","status":"available","version":"1.0.0\\nfake: line"}]',
      '[{"upstreamId":"u1","status":"available","version":""}]',
    ]) {
      expectInputError(() => parseUpstreamRecordsJson(badJson));
    }

    const parsed = parseUpstreamRecordsJson(JSON.stringify([{ upstreamId: 'pi-ai', status: 'held_back', version: '0.62.0', currentVersion: '0.61.0', reason: 'lockstep' }]));
    assert.equal(parsed[0]?.version, '0.61.0');
    assert.equal(parsed[0]?.targetVersion, '0.62.0');
    const enriched = attachUpstreamContext(parsed, [{ id: 'pi-ai', kind: 'http-json', source: 'https://registry.npmjs.org/pi-ai', watchedPaths: ['packages/agent-pi/package.json'] }]);
    assert.match(formatUpstreamSummary(enriched), /packages\/agent-pi\/package\.json/);
    assert.equal(formatUpstreamSummary([{ upstreamId: 'u1', status: 'failed', reason: 'l1\nl2\r\nl3' }]).split('\n').length, 1);
  });

  it('discovers http-json upstreams via versionPath and blocks unsafe URLs before fetch', async () => {
    let fetched = false;
    const unsafeManifest = makeV2Manifest({
      upstreams: [
        { id: 'plain-http', kind: 'http-json', source: 'http://example.com/v.json', watchedPaths: ['docs'] },
        { id: 'with-creds', kind: 'http-json', source: 'https://user:pass@example.com/v.json', watchedPaths: ['docs'] },
        { id: 'with-frag', kind: 'http-json', source: 'https://example.com/v.json#frag', watchedPaths: ['docs'] },
        { id: 'bad-scheme', kind: 'http-json', source: 'file:///etc/passwd', watchedPaths: ['docs'] },
      ],
    });
    const unsafeRecords = await discoverTaskpackUpstreams(unsafeManifest, {
      fetchImpl: async () => { fetched = true; return new Response('{}', { status: 200 }); },
    });
    assert.equal(fetched, false);
    assert.ok(unsafeRecords.every(r => r.status === 'failed'));

    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const routes: Record<string, unknown> = {
        '/npm': { 'dist-tags': { latest: '4.2.0' } },
        '/scoped': { packages: { '@scope/pkg': { version: '1.2.3' } } },
        '/missing': { other: 'value' },
      };
      res.end(JSON.stringify(routes[req.url ?? ''] ?? {}));
    });
    try {
      const discovered = await discoverTaskpackUpstreams(makeV2Manifest({
        upstreams: [
          { id: 'npm-pkg', kind: 'http-json', source: `${server.url}/npm`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest' },
          { id: 'scoped-pkg', kind: 'http-json', source: `${server.url}/scoped`, watchedPaths: ['packages/core/package.json'], versionPath: "packages['@scope/pkg'].version" },
          { id: 'missing-path', kind: 'http-json', source: `${server.url}/missing`, watchedPaths: ['docs'], versionPath: '$.data.releases[0].version' },
        ],
      }), { includeMetadata: true });
      assert.equal(discovered[0]?.version, '4.2.0');
      assert.equal(discovered[1]?.version, '1.2.3');
      assert.equal(discovered[2]?.status, 'failed');
    } finally {
      await server.close();
    }
  });
});

describe('upstreams.ts: monotonicSemver downgrade protection & lockstep upstreamGroups', () => {
  it('holds back lower SemVer by default, allows monotonicSemver: false, and preserves memory baselines', async () => {
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const versions: Record<string, string> = { '/down': '1.4.0', '/pre': '2.0.0-rc.1', '/up': '1.6.0' };
      res.end(JSON.stringify({ 'dist-tags': { latest: versions[req.url ?? ''] ?? '1.0.0' } }));
    });
    try {
      const result = await discoverTaskpackUpstreamsV2(makeV2Manifest({
        upstreams: [
          { id: 'pkg-default', kind: 'http-json', source: `${server.url}/down`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest' },
          { id: 'pkg-pre', kind: 'http-json', source: `${server.url}/pre`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest' },
          { id: 'pkg-allow-down', kind: 'http-json', source: `${server.url}/down`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest', monotonicSemver: false },
          { id: 'pkg-up', kind: 'http-json', source: `${server.url}/up`, watchedPaths: ['docs/versions.md'], versionPath: 'dist-tags.latest' },
        ],
      }), { baselineVersions: { 'pkg-default': '1.5.0', 'pkg-pre': '2.0.0', 'pkg-allow-down': '1.5.0', 'pkg-up': '1.5.0' } });

      assert.equal(result.records[0]?.status, 'held_back');
      assert.equal(result.records[0]?.targetVersion, '1.4.0');
      assert.equal(result.records[1]?.status, 'held_back');
      assert.equal(result.records[2]?.status, 'available');
      assert.equal(result.records[3]?.status, 'available');
      assert.equal(result.memoryVersions['pkg-default'], '1.5.0');
      assert.equal(result.memoryVersions['pkg-up'], '1.6.0');
      assert.equal(result.disposition, 'candidate');
    } finally {
      await server.close();
    }
  });

  it('enforces atomic lockstep groups: mismatch holds group, HTTP 503 resolves blocked, agreement proceeds', async () => {
    const groups = [
      { id: 'pi-suite', members: ['pi-ai', 'pi-coding'], policy: 'lockstep' as const },
      { id: 'misc', members: ['yaml-lib'], policy: 'independent' as const },
    ];

    // Mismatch holds lockstep group while independent sibling proceeds
    const mismatched = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'available', version: '0.62.0', currentVersion: '0.61.0' },
      { upstreamId: 'pi-coding', status: 'available', version: '0.61.5', currentVersion: '0.61.0' },
      { upstreamId: 'yaml-lib', status: 'available', version: '2.9.2', currentVersion: '2.9.1' },
    ], groups);
    assert.equal(mismatched[0]?.status, 'held_back');
    assert.equal(mismatched[0]?.groupId, 'pi-suite');
    assert.equal(mismatched[1]?.status, 'held_back');
    assert.equal(mismatched[2]?.status, 'available');
    assert.equal(evaluateUpstreamIntakeDisposition(mismatched).disposition, 'candidate');
    assert.equal(buildUpstreamMemoryVersions(mismatched)['pi-ai'], '0.61.0');

    // Underlying failure with zero available siblings resolves blocked (vs non-failure held_back -> no_change)
    const failedGroup = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'available', version: '2.0.0', currentVersion: '1.0.0' },
      { upstreamId: 'pi-coding', status: 'failed', currentVersion: '1.0.0', reason: 'HTTP 503' },
      { upstreamId: 'yaml-lib', status: 'up_to_date', version: '3.0.0', currentVersion: '3.0.0' },
    ], groups);
    assert.equal(failedGroup[1]?.underlyingStatus, 'failed');
    assert.equal(evaluateUpstreamIntakeDisposition(failedGroup).disposition, 'blocked');

    const heldOnly: readonly UpstreamAcquisitionRecord[] = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'available', version: '2.0.0', currentVersion: '1.0.0' },
      { upstreamId: 'pi-coding', status: 'held_back', version: '1.0.0', currentVersion: '1.0.0', targetVersion: '0.9.0', reason: 'downgrade' },
    ], [groups[0]!]);
    assert.equal(evaluateUpstreamIntakeDisposition(heldOnly).disposition, 'no_change');

    // Agreement proceeds atomically
    const agreed = applyUpstreamGroups([
      { upstreamId: 'pi-ai', status: 'available', version: '0.62.0', currentVersion: '0.61.0' },
      { upstreamId: 'pi-coding', status: 'up_to_date', version: '0.62.0', currentVersion: '0.62.0' },
    ], [groups[0]!]);
    assert.equal(agreed[0]?.status, 'available');
    assert.equal(agreed[1]?.status, 'up_to_date');

    // Live HTTP 503 outage across all lockstep members reports blocked with per-member details
    const outage = await startMockServer((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `outage on ${req.url ?? ''}` }));
    });
    try {
      const res = await discoverTaskpackUpstreamsV2(makeV2Manifest({
        upstreams: [
          { id: 'pkg-a', kind: 'http-json', source: `${outage.url}/a`, watchedPaths: ['package.json'] },
          { id: 'pkg-b', kind: 'http-json', source: `${outage.url}/b`, watchedPaths: ['package.json'] },
        ],
        upstreamGroups: [{ id: 'suite', members: ['pkg-a', 'pkg-b'], policy: 'lockstep' }],
      }));
      assert.equal(res.disposition, 'blocked');
      assert.equal(res.records[0]?.underlyingStatus, 'failed');
      assert.match(res.records[0]?.reason ?? '', /pkg-a/);
      assert.match(res.records[0]?.reason ?? '', /pkg-b/);
    } finally {
      await outage.close();
    }
  });
});

describe('upstreams.ts: proposal-optional baselines & fail-closed repo reads', () => {
  it('resolves package.json baselines cleanly, ignores comparator/protocol specs, and fails closed on symlinked or malformed files', async () => {
    const work = await mkdtemp(join(tmpdir(), 'loopwright-upstreams-baseline-'));
    const server = await startMockServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ 'dist-tags': { latest: req.url === '/yaml' ? '2.9.1' : '1.0.0' } }));
    });
    try {
      const repoOk = join(work, 'repo-ok');
      const repoEmpty = join(work, 'repo-empty');
      const repoSymlink = join(work, 'repo-symlink');
      const repoBad = join(work, 'repo-bad');
      for (const dir of [repoOk, repoEmpty, repoSymlink, repoBad]) await mkdir(dir, { recursive: true });
      await writeFile(join(repoOk, 'package.json'), JSON.stringify({ dependencies: { yaml: '^2.9.1', 'pkg-cmp': '>=2.0.0', 'pkg-proto': 'catalog:default' } }), 'utf8');
      const outside = join(work, 'outside.json');
      await writeFile(outside, '{"dependencies":{"yaml":"2.0.0"}}', 'utf8');
      await symlink(outside, join(repoSymlink, 'package.json'));
      await writeFile(join(repoBad, 'package.json'), '{ bad json', 'utf8');

      const manifest = makeV2Manifest({
        upstreams: [
          { id: 'yaml', kind: 'http-json', source: `${server.url}/yaml`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest' },
          { id: 'pkg-cmp', kind: 'http-json', source: `${server.url}/cmp`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest' },
          { id: 'pkg-proto', kind: 'http-json', source: `${server.url}/proto`, watchedPaths: ['package.json'], versionPath: 'dist-tags.latest' },
        ],
        upstreamGroups: [{ id: 'g', members: ['yaml', 'pkg-cmp'], policy: 'lockstep' }],
      });

      const okRes = await discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoOk });
      assert.equal(okRes.records[0]?.currentVersion, '2.9.1');
      assert.equal(okRes.records[1]?.currentVersion, undefined);
      assert.equal(okRes.records[2]?.currentVersion, undefined);

      // upstreamRecordsJson forwards package.json baseline into lockstep evaluation
      const fromJson = await discoverTaskpackUpstreams(manifest, {
        repositoryRoot: repoOk,
        upstreamRecordsJson: JSON.stringify([
          { upstreamId: 'yaml', status: 'available', version: '3.0.0' },
          { upstreamId: 'pkg-cmp', status: 'available', version: '2.5.0' },
        ]),
      });
      assert.equal(fromJson[0]?.status, 'held_back');
      assert.equal(fromJson[0]?.currentVersion, '2.9.1');

      // Empty repo & proposal-omitted PR match stay safe
      const emptyRes = await discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoEmpty });
      assert.equal(emptyRes.records[0]?.status, 'held_back');
      assert.equal(await checkManagedPrMatchesDiscoveredState({
        repositoryRoot: repoEmpty, repositoryFullName: 'acme/demo', manifest, records: emptyRes.records,
        openManagedPr: { number: 1, htmlUrl: 'https://github.com/acme/demo/pull/1', headRef: 'sync/1', headSha: 'a'.repeat(40), baseRef: 'main', baseSha: 'b'.repeat(40), title: 'sync', body: null },
      }), false);

      // Symlinked or malformed baseline package.json fails closed
      await assert.rejects(discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoSymlink }), (err: unknown) => err instanceof GitHubAppError);
      await assert.rejects(discoverTaskpackUpstreamsV2(manifest, { repositoryRoot: repoBad }), (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID');
    } finally {
      await server.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
