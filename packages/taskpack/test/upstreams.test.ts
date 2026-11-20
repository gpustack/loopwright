import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { TaskpackError } from '../src/types.js';
import { validateTaskpackV2Manifest, type Json } from '../src/schema.js';
import {
  applyUpstreamGroups,
  compareStrictSemver,
  compareVersionTags,
  discoverTaskpackUpstreams,
  discoverTaskpackUpstreamsV2,
  extractJsonVersionPath,
  findOpenManagedPullRequest,
} from '../src/upstreams.js';

async function startServer(
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

describe('upstreams.ts: injectable auth, SemVer tuple sorting, and lockstep groups', () => {
  it('supports injectable async githubToken / authHeaders and numeric SemVer tuple sorting on github-release', async () => {
    assert.ok(compareVersionTags('v10.0.0', 'v9.0.0') > 0);
    assert.ok(compareVersionTags('v1.2.0', 'v1.2.0-rc.1') > 0);
    assert.equal(compareStrictSemver('2.0.0', '10.0.0'), -1);

    const seenAuthHeaders: string[] = [];
    const seenCustomHeaders: string[] = [];
    const server = await startServer((req, res) => {
      if (typeof req.headers['authorization'] === 'string') {
        seenAuthHeaders.push(req.headers['authorization']);
      }
      if (typeof req.headers['x-custom-auth'] === 'string') {
        seenCustomHeaders.push(req.headers['x-custom-auth']);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/repos/octo/tool/releases/latest') {
        // Latest release is a prerelease tag, forcing fallback to /releases?per_page=30 SemVer selection
        res.end(JSON.stringify({ tag_name: 'v11.0.0-rc.1', prerelease: false }));
        return;
      }
      if (req.url === '/repos/octo/tool/releases?per_page=30') {
        res.end(JSON.stringify([
          { tag_name: 'v9.0.0', prerelease: false, draft: false },
          { tag_name: 'v10.0.0', prerelease: false, draft: false },
          { tag_name: 'v11.0.0-rc.1', prerelease: false, draft: false },
        ]));
        return;
      }
      res.end('{}');
    });

    try {
      const manifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'upstream-semver' },
        spec: {
          goal: { candidate: 'Sync', noChange: 'Verify' },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [
            {
              id: 'tool',
              kind: 'github-release',
              source: 'octo/tool',
              watchedPaths: ['docs/tool.md'],
              allowPrerelease: false,
            },
          ],
          verification: { localChecks: [], externalGates: [] },
        },
      } as Json);

      const result = await discoverTaskpackUpstreamsV2(manifest, {
        apiBaseUrl: server.url,
        githubToken: async () => 'tok_injected_1234567890',
        authHeaders: async () => ({ 'x-custom-auth': 'custom-val' }),
        baselineVersions: { tool: 'v9.0.0' },
      });

      assert.equal(result.disposition, 'candidate');
      assert.equal(result.records[0]?.version, 'v10.0.0');
      assert.equal(result.records[0]?.status, 'available');
      assert.ok(seenAuthHeaders.includes('Bearer tok_injected_1234567890'));
      assert.ok(seenCustomHeaders.includes('custom-val'));
    } finally {
      await server.close();
    }
  });

  it('traverses versionPath safely, holds back lockstep mismatches, and refuses prototype keys', async () => {
    assert.equal(extractJsonVersionPath({ a: { b: ['1.2.3'] } }, '$.a.b[0]'), '1.2.3');
    assert.throws(
      () => extractJsonVersionPath({ a: 1 }, '__proto__.polluted'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
    );

    const grouped = applyUpstreamGroups(
      [
        { upstreamId: 'a', status: 'available', version: '2.0.0', currentVersion: '1.0.0' },
        { upstreamId: 'b', status: 'up_to_date', version: '1.0.0', currentVersion: '1.0.0' },
      ],
      [{ id: 'pair', members: ['a', 'b'], policy: 'lockstep' }],
    );
    assert.equal(grouped[0]?.status, 'held_back');
    assert.equal(grouped[0]?.version, '1.0.0');
    assert.equal(grouped[0]?.targetVersion, '2.0.0');
    assert.equal(grouped[1]?.status, 'held_back');

    const emptyManifest = validateTaskpackV2Manifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'empty-upstreams' },
      spec: {
        goal: { candidate: 'Sync', noChange: 'Verify' },
        scope: { writable: ['docs/**'], protected: [] },
        verification: { localChecks: [], externalGates: [] },
      },
    } as Json);
    assert.deepEqual(await discoverTaskpackUpstreams(emptyManifest), []);

    await assert.rejects(
      findOpenManagedPullRequest({
        apiBaseUrl: 'https://api.example.test',
        repositoryFullName: 'octo/tool',
        targetBranch: 'main',
        headBranchPrefix: 'lw/',
        fetchImpl: async () => new Response(
          JSON.stringify(Array.from({ length: 100 }, (_, idx) => ({
            number: idx + 1,
            html_url: `https://example.test/pull/${idx + 1}`,
            head: { ref: `feature/${idx}`, sha: 'a'.repeat(40), repo: { full_name: 'octo/tool', fork: false } },
            base: { ref: 'main', sha: 'b'.repeat(40) },
            title: 'other',
          }))),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
    );
  });
});
