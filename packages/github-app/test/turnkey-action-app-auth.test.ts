import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inspectRun, signPayload } from '@loopwright/controller';
import {
  buildNativePullRequestBody,
  checkManagedPrMatchesDiscoveredState,
  DEFAULT_GIT_COMMIT_IDENTITY,
  GitHubAppError,
  loadDeclarativeTaskpack,
  resolveGitHubAuth,
  resolveGitHubToken,
  runActionCli,
  runGitHubActionEntrypoint,
  SecretScrubber,
  startNativePullRequestPublisherServer,
} from '../src/index.js';
import {
  git,
  sseToolCall,
  sseStop,
  readJsonBody,
  startHttpServer,
  createEndToEndFixture,
  writeTaskpackYaml,
} from './turnkey-action-fixtures.js';

describe('GitHub App installation auto-discovery, token precedence, and DCO bot commit identity', () => {
  const { privateKey: testAppPrivateKeyObj, publicKey: testAppPublicKeyObj } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const testAppPrivateKeyPem = testAppPrivateKeyObj.export({ type: 'pkcs8', format: 'pem' }).toString();

  function assertValidAppJwt(authHeader: string | undefined, expectedAppId: string): void {
    assert.ok(typeof authHeader === 'string' && authHeader.startsWith('Bearer '), `missing Bearer JWT: ${String(authHeader)}`);
    const token = authHeader.slice('Bearer '.length);
    const parts = token.split('.');
    assert.equal(parts.length, 3, 'JWT must have 3 segments');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string; typ?: string };
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { iss?: string };
    assert.equal(header.alg, 'RS256');
    assert.equal(payload.iss, expectedAppId);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]!}.${parts[1]!}`);
    assert.equal(
      verifier.verify(testAppPublicKeyObj, Buffer.from(parts[2]!, 'base64url')),
      true,
      'JWT RS256 signature must verify against App public key',
    );
  }

  it('auto-discovers installation without github-app-installation-id, overrides ambient GITHUB_TOKEN, and signs off as <id>+<slug>[bot]', async () => {
    const fixture = await createEndToEndFixture();
    let llmTurn = 0;
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let githubServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    const ambientShadowToken = 'ghs_ambient_shadow_tok_999999999999999999';
    const mintedAppToken = 'ghs_minted_app_tok_5722657000000000001';
    const observedAuthByRoute: Array<{ readonly method: string; readonly rawUrl: string; readonly auth: string }> = [];
    const prRequests: Record<string, unknown>[] = [];

    try {
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
          res.writeHead(404);
          res.end();
          return;
        }
        const step = llmTurn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-app-1', 'write', {
            path: 'pack/proposal.json',
            content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'call-app-2', 'write', {
            path: 'docs/status.md',
            content: 'verified-ok\n',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      githubServer = await startHttpServer(async (req, res) => {
        const rawUrl = req.url ?? '/';
        const auth = String(req.headers['authorization'] ?? '');
        observedAuthByRoute.push({ method: req.method ?? 'GET', rawUrl, auth });

        if (req.method === 'GET' && rawUrl === '/repos/gpustack/runner/installation') {
          assertValidAppJwt(auth, '5722657');
          assert.equal(req.headers['accept'], 'application/vnd.github+json');
          assert.equal(req.headers['user-agent'], 'loopwright-github-app');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 99887766, app_slug: 'gpustack-loopwright' }));
          return;
        }
        if (req.method === 'POST' && rawUrl === '/app/installations/99887766/access_tokens') {
          assertValidAppJwt(auth, '5722657');
          const tokenReqBody = await readJsonBody(req);
          assert.deepEqual(tokenReqBody['repositories'], ['runner']);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ token: mintedAppToken, expires_at: '2099-01-01T00:00:00Z' }));
          return;
        }
        if (req.method === 'GET' && rawUrl === '/users/gpustack-loopwright%5Bbot%5D') {
          assert.equal(auth, `Bearer ${mintedAppToken}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 355636659, login: 'gpustack-loopwright[bot]', type: 'Bot' }));
          return;
        }
        if (req.method === 'GET' && rawUrl === '/repos/gpustack/runner') {
          assert.equal(auth, `Bearer ${mintedAppToken}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 420001 }));
          return;
        }
        if (req.method === 'GET' && rawUrl === '/repos/acme/engine/releases/latest') {
          assert.equal(auth, `Bearer ${mintedAppToken}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (req.method === 'GET' && rawUrl.startsWith('/repos/gpustack/runner/pulls')) {
          assert.equal(auth, `Bearer ${mintedAppToken}`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === 'POST' && rawUrl === '/repos/gpustack/runner/pulls') {
          assert.equal(auth, `Bearer ${mintedAppToken}`);
          const payload = await readJsonBody(req);
          prRequests.push(payload);
          const headRef = String(payload['head'] ?? '');
          const isMemPr = headRef.startsWith('loopwright/memory/');
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: isMemPr ? 421 : 420,
            html_url: isMemPr
              ? 'https://github.invalid/gpustack/runner/pull/421'
              : 'https://github.invalid/gpustack/runner/pull/420',
            head: { ref: headRef || 'loopwright/main', sha: '0'.repeat(40) },
            base: { ref: 'main', sha: fixture.baseSha },
            title: String(payload['title'] ?? ''),
            body: String(payload['body'] ?? ''),
          }));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      });

      await writeTaskpackYaml(fixture.repo, openAiServer.url);
      await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
      await git(fixture.repo, ['commit', '-m', 'add taskpack']);
      const headSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
      await git(fixture.repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      const summaryFile = join(fixture.work, 'step-summary.md');
      const outputFile = join(fixture.work, 'github-output.txt');

      const exitCode = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: fixture.repo,
        GITHUB_REPOSITORY: 'gpustack/runner',
        GITHUB_SHA: headSha,
        GITHUB_API_URL: githubServer.url,
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_OUTPUT: outputFile,
        // Ambient GITHUB_TOKEN must NOT shadow github-app-id + github-app-private-key!
        GITHUB_TOKEN: ambientShadowToken,
        'INPUT_GITHUB-TOKEN': '',
        'INPUT_GITHUB-APP-ID': '5722657',
        'INPUT_GITHUB-APP-PRIVATE-KEY': testAppPrivateKeyPem,
        'INPUT_GITHUB-APP-INSTALLATION-ID': '',
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': fixture.runRoot,
        'INPUT_RUN-ID': 'turnkey-app-autodiscover',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_REMOTE-URL': fixture.bareRemote,
        LLM_TOKEN: fixture.goodToken,
        CHECK_SECRET: fixture.verifySecret,
      });

      assert.equal(exitCode, 0, 'Action run with auto-discovered GitHub App installation must succeed');
      assert.equal(prRequests.length, 2, 'must open managed PR and separate memory PR with minted App token');
      assert.equal(prRequests[0]?.['head'], 'loopwright/main');
      assert.match(String(prRequests[1]?.['head'] ?? ''), /^loopwright\/memory\//);
      assert.equal(
        observedAuthByRoute.some(entry => entry.rawUrl === '/repos/gpustack/runner/installation'),
        true,
        'must call GET /repos/gpustack/runner/installation',
      );
      assert.equal(
        observedAuthByRoute.some(entry => entry.rawUrl === '/users/gpustack-loopwright%5Bbot%5D'),
        true,
        'must call GET /users/gpustack-loopwright%5Bbot%5D',
      );
      assert.equal(
        observedAuthByRoute.some(entry => entry.rawUrl === '/app'),
        false,
        'must not need GET /app when app_slug was returned by /repos/.../installation',
      );
      assert.equal(
        observedAuthByRoute.some(entry => entry.auth.includes(ambientShadowToken)),
        false,
        'ambient GITHUB_TOKEN must never shadow GitHub App credentials',
      );

      const verifyClone = join(fixture.work, 'verify-app-remote');
      await git(fixture.work, ['clone', '--branch', 'loopwright/main', fixture.bareRemote, verifyClone]);
      const expectedIdentity = 'gpustack-loopwright[bot] <355636659+gpustack-loopwright[bot]@users.noreply.github.com>';
      assert.equal(await git(verifyClone, ['log', '-1', '--format=%an <%ae>']), expectedIdentity);
      assert.equal(await git(verifyClone, ['log', '-1', '--format=%cn <%ce>']), expectedIdentity);
      const commitBody = await git(verifyClone, ['log', '-1', '--format=%B']);
      assert.match(
        commitBody,
        /Signed-off-by: gpustack-loopwright\[bot\] <355636659\+gpustack-loopwright\[bot\]@users\.noreply\.github\.com>/,
      );
      assert.equal(commitBody.includes('<loopwright[bot]@users.noreply.github.com>'), false);

      const summaryContent = await readFile(summaryFile, 'utf8');
      const outputContent = await readFile(outputFile, 'utf8');
      for (const secret of [mintedAppToken, ambientShadowToken, testAppPrivateKeyPem]) {
        assert.equal(summaryContent.includes(secret), false);
        assert.equal(outputContent.includes(secret), false);
      }
    } finally {
      await openAiServer?.close();
      await githubServer?.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });

  it('resolves bot slug via GET /app when github-app-installation-id is explicit and falls back to github-actions[bot] on 404', async () => {
    let appStatus = 200;
    let userStatus = 200;
    const calledPaths: string[] = [];

    const githubServer = await startHttpServer((req, res) => {
      const rawUrl = req.url ?? '/';
      calledPaths.push(`${req.method} ${rawUrl}`);
      const auth = String(req.headers['authorization'] ?? '');

      if (req.method === 'POST' && rawUrl === '/app/installations/776655/access_tokens') {
        assertValidAppJwt(auth, '5722657');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ token: 'ghs_explicit_install_tok_1234567890123456' }));
        return;
      }
      if (req.method === 'GET' && rawUrl === '/app') {
        assertValidAppJwt(auth, '5722657');
        if (appStatus !== 200) {
          res.writeHead(appStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not Found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 5722657, slug: 'gpustack-loopwright' }));
        return;
      }
      if (req.method === 'GET' && rawUrl === '/users/gpustack-loopwright%5Bbot%5D') {
        assert.equal(auth, 'Bearer ghs_explicit_install_tok_1234567890123456');
        if (userStatus !== 200) {
          res.writeHead(userStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not Found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 355636659, login: 'gpustack-loopwright[bot]', type: 'Bot' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      // 1) Explicit installation ID + 200 from /app and /users/...
      const resolvedOk = await resolveGitHubAuth({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'gpustack/runner',
        appId: 5722657,
        appPrivateKey: testAppPrivateKeyPem,
        appInstallationId: 776655,
      });
      assert.equal(resolvedOk.token, 'ghs_explicit_install_tok_1234567890123456');
      assert.equal(resolvedOk.installationId, 776655);
      assert.deepEqual(resolvedOk.gitCommitIdentity, {
        name: 'gpustack-loopwright[bot]',
        email: '355636659+gpustack-loopwright[bot]@users.noreply.github.com',
      });
      assert.equal(
        calledPaths.some(entry => entry.includes('/repos/')),
        false,
        'must not call /repos/.../installation when installation ID is explicit',
      );
      assert.equal(calledPaths.includes('GET /app'), true);
      assert.equal(calledPaths.includes('GET /users/gpustack-loopwright%5Bbot%5D'), true);

      // 2) /app returns 404 -> graceful fallback to canonical DCO-valid github-actions[bot]
      calledPaths.length = 0;
      appStatus = 404;
      const fallbackOnApp404 = await resolveGitHubAuth({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'gpustack/runner',
        appId: 5722657,
        appPrivateKey: testAppPrivateKeyPem,
        appInstallationId: 776655,
      });
      assert.equal(fallbackOnApp404.token, 'ghs_explicit_install_tok_1234567890123456');
      assert.deepEqual(fallbackOnApp404.gitCommitIdentity, DEFAULT_GIT_COMMIT_IDENTITY);
      assert.equal(fallbackOnApp404.gitCommitIdentity.email, '41898282+github-actions[bot]@users.noreply.github.com');

      // 3) /app returns 200, /users/... returns 404 -> graceful fallback to canonical DCO-valid github-actions[bot]
      calledPaths.length = 0;
      appStatus = 200;
      userStatus = 404;
      const fallbackOnUser404 = await resolveGitHubAuth({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'gpustack/runner',
        appId: 5722657,
        appPrivateKey: testAppPrivateKeyPem,
        appInstallationId: 776655,
      });
      assert.equal(fallbackOnUser404.token, 'ghs_explicit_install_tok_1234567890123456');
      assert.deepEqual(fallbackOnUser404.gitCommitIdentity, DEFAULT_GIT_COMMIT_IDENTITY);
    } finally {
      await githubServer.close();
    }
  });

  it('preserves explicit INPUT_GITHUB-TOKEN precedence over github-app-id and ambient GITHUB_TOKEN', async () => {
    const calledRoutes: string[] = [];
    const explicitPat = 'ghp_explicit_override_tok_123456789012345';
    const ambientToken = 'ghs_ambient_ignored_tok_12345678901234567';

    const githubServer = await startHttpServer((req, res) => {
      const rawUrl = req.url ?? '/';
      calledRoutes.push(`${req.method} ${rawUrl}`);
      if (req.method === 'GET' && rawUrl === '/user') {
        assert.equal(req.headers['authorization'], `Bearer ${explicitPat}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 887766, login: 'release-maintainer' }));
        return;
      }
      res.writeHead(500);
      res.end();
    });

    try {
      const tokenOnly = await resolveGitHubToken({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'gpustack/runner',
        env: {
          'INPUT_GITHUB-TOKEN': explicitPat,
          'INPUT_GITHUB-APP-ID': '5722657',
          'INPUT_GITHUB-APP-PRIVATE-KEY': testAppPrivateKeyPem,
          GITHUB_TOKEN: ambientToken,
        },
      });
      assert.equal(tokenOnly, explicitPat);
      assert.equal(calledRoutes.length, 0, 'resolveGitHubToken must not perform extra HTTP requests when explicit token is set');

      const auth = await resolveGitHubAuth({
        apiBaseUrl: githubServer.url,
        repositoryFullName: 'gpustack/runner',
        env: {
          'INPUT_GITHUB-TOKEN': explicitPat,
          'INPUT_GITHUB-APP-ID': '5722657',
          'INPUT_GITHUB-APP-PRIVATE-KEY': testAppPrivateKeyPem,
          GITHUB_TOKEN: ambientToken,
        },
      });
      assert.equal(auth.token, explicitPat);
      assert.deepEqual(auth.gitCommitIdentity, {
        name: 'release-maintainer',
        email: '887766+release-maintainer@users.noreply.github.com',
      });
      assert.deepEqual(calledRoutes, ['GET /user'], 'must not invoke any /app or /installations routes when INPUT_GITHUB-TOKEN is set');
    } finally {
      await githubServer.close();
    }
  });

  it('validates git-author-name/email against injection, deduplicates Signed-off-by trailers, and fails closed on invalid installation discovery', async () => {
    const githubServer = await startHttpServer((req, res) => {
      if (req.url === '/repos/gpustack/uninstalled/installation') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      if (req.url === '/repos/gpustack/malformed/installation') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 0, app_slug: 'gpustack-loopwright' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const fixture = await createEndToEndFixture();
    try {
      // Missing or invalid owner/repo when installation ID is omitted -> TOKEN_BROKER_CONFIG_INVALID
      await assert.rejects(
        () => resolveGitHubToken({
          apiBaseUrl: githubServer.url,
          repositoryFullName: 'not-owner-slash-repo',
          appId: 5722657,
          appPrivateKey: testAppPrivateKeyPem,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TOKEN_BROKER_CONFIG_INVALID',
      );
      await assert.rejects(
        () => resolveGitHubToken({
          apiBaseUrl: githubServer.url,
          repositoryFullName: 'gpustack/uninstalled',
          appId: 5722657,
          appPrivateKey: testAppPrivateKeyPem,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TOKEN_BROKER_CONFIG_INVALID',
      );
      await assert.rejects(
        () => resolveGitHubToken({
          apiBaseUrl: githubServer.url,
          repositoryFullName: 'gpustack/malformed',
          appId: 5722657,
          appPrivateKey: testAppPrivateKeyPem,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TOKEN_BROKER_CONFIG_INVALID',
      );

      // Reject CR/LF/NUL and angle-bracket injection in gitAuthorName / gitAuthorEmail
      for (const badIdentity of [
        { name: 'Bot\nCo-authored-by: Malloy <m@x.test>', email: '1+bot@users.noreply.github.com' },
        { name: 'Bot\r', email: '1+bot@users.noreply.github.com' },
        { name: 'Bot\0', email: '1+bot@users.noreply.github.com' },
        { name: 'Bot <inject@x.test>', email: '1+bot@users.noreply.github.com' },
        { name: 'Bot', email: '1+bot@users.noreply.github.com\nSigned-off-by: x' },
        { name: 'Bot', email: '<1+bot@users.noreply.github.com>' },
        { name: 'Bot', email: 'not-an-email' },
      ]) {
        await assert.rejects(
          () => startNativePullRequestPublisherServer({
            runRoot: fixture.runRoot,
            repositoryRoot: fixture.repo,
            repositoryFullName: 'gpustack/runner',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright/',
            gitCommitIdentity: badIdentity,
          }),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID',
        );
      }

      await writeTaskpackYaml(fixture.repo, 'https://api.openai.com');
      const blockedNewline = await runGitHubActionEntrypoint({
        repositoryRoot: fixture.repo,
        taskpackPath: '.auto-sync/taskpack.yaml',
        repositoryFullName: 'gpustack/runner',
        baseRevision: fixture.baseSha,
        mode: 'candidate',
        eventName: 'workflow_dispatch',
        runRoot: fixture.runRoot,
        runId: 'run-bad-git-author',
        dryRun: true,
        env: {
          ...process.env,
          'INPUT_GIT-AUTHOR-NAME': 'Injected\nTrailer: bad',
        },
      });
      assert.equal(blockedNewline.kind, 'blocked');
      if (blockedNewline.kind === 'blocked') {
        assert.equal(blockedNewline.reason, 'ACTION_INPUT_INVALID');
      }

      // Explicit INPUT_GIT-AUTHOR-NAME + INPUT_GIT-AUTHOR-EMAIL override via resolveGitHubAuth
      const explicitAuth = await resolveGitHubAuth({
        env: {
          'INPUT_GIT-AUTHOR-NAME': 'Custom Release Bot',
          'INPUT_GIT-AUTHOR-EMAIL': '9001+custom-bot[bot]@users.noreply.github.com',
        },
      });
      assert.deepEqual(explicitAuth.gitCommitIdentity, {
        name: 'Custom Release Bot',
        email: '9001+custom-bot[bot]@users.noreply.github.com',
      });

      // Verify startNativePullRequestPublisherServer avoids duplicating exact Signed-off-by trailer when already present
      let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
      try {
        let turn = 0;
        openAiServer = await startHttpServer((req, res) => {
          if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
            res.writeHead(404);
            res.end();
            return;
          }
          const step = turn++;
          const body = step === 0
            ? sseToolCall('gpt-4.1-mini', 'c1', 'write', {
              path: 'pack/proposal.json',
              content: `${JSON.stringify({ schema_version: 1, version: '2.0.0' })}\n`,
            })
            : step === 1
              ? sseToolCall('gpt-4.1-mini', 'c2', 'write', {
                path: 'docs/status.md',
                content: 'verified-ok\n',
              })
              : sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(body);
        });

        const customSignoff = 'Signed-off-by: Custom Release Bot <9001+custom-bot[bot]@users.noreply.github.com>';
        await writeTaskpackYaml(fixture.repo, openAiServer.url);
        await git(fixture.repo, ['add', '.auto-sync/taskpack.yaml']);
        await git(fixture.repo, ['commit', '-m', 'add custom signoff taskpack']);
        const headSha = await git(fixture.repo, ['rev-parse', 'HEAD']);
        await git(fixture.repo, ['push', 'origin', 'HEAD:refs/heads/main']);

        const mockGh = await startHttpServer(async (req, res) => {
          if (req.method === 'GET' && req.url === '/repos/acme/engine/releases/latest') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
            return;
          }
          if (req.method === 'GET' && req.url === '/repos/gpustack/runner') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: 901 }));
            return;
          }
          if (req.method === 'GET' && req.url?.startsWith('/repos/gpustack/runner/pulls')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify([]));
            return;
          }
          if (req.method === 'POST' && req.url === '/repos/gpustack/runner/pulls') {
            const payload = await readJsonBody(req);
            const headRef = String(payload['head'] ?? '');
            const isMemPr = headRef.startsWith('loopwright/memory/');
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              number: isMemPr ? 100 : 99,
              html_url: isMemPr
                ? 'https://github.invalid/gpustack/runner/pull/100'
                : 'https://github.invalid/gpustack/runner/pull/99',
              head: { ref: headRef || 'loopwright/main', sha: '0'.repeat(40) },
              base: { ref: 'main', sha: headSha },
              title: 'chore: update synced pack',
              body: '',
            }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        let dedupPubServer: Awaited<ReturnType<typeof startNativePullRequestPublisherServer>> | undefined;
        try {
          const code = await runActionCli({
            PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
            GITHUB_ACTIONS: 'true',
            GITHUB_WORKSPACE: fixture.repo,
            GITHUB_REPOSITORY: 'gpustack/runner',
            GITHUB_SHA: headSha,
            GITHUB_API_URL: mockGh.url,
            GITHUB_TOKEN: fixture.githubToken,
            'INPUT_GIT-AUTHOR-NAME': 'Custom Release Bot',
            'INPUT_GIT-AUTHOR-EMAIL': '9001+custom-bot[bot]@users.noreply.github.com',
            'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
            'INPUT_EVENT-NAME': 'workflow_dispatch',
            'INPUT_RUN-ROOT': fixture.runRoot,
            'INPUT_RUN-ID': 'turnkey-custom-dedup',
            'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
            'INPUT_REMOTE-URL': fixture.bareRemote,
            LLM_TOKEN: fixture.goodToken,
            CHECK_SECRET: fixture.verifySecret,
          });
          assert.equal(code, 0);
          const verifyClone = join(fixture.work, 'verify-custom-override');
          await git(fixture.work, ['clone', '--branch', 'loopwright/main', fixture.bareRemote, verifyClone]);
          assert.equal(
            await git(verifyClone, ['log', '-1', '--format=%an <%ae>']),
            'Custom Release Bot <9001+custom-bot[bot]@users.noreply.github.com>',
          );
          assert.equal(
            await git(verifyClone, ['log', '-1', '--format=%cn <%ce>']),
            'Custom Release Bot <9001+custom-bot[bot]@users.noreply.github.com>',
          );

          // Now publish the same verified candidate through startNativePullRequestPublisherServer
          // with a pre-signed-off commit message and verify the exact trailer is NOT duplicated.
          const canonicalRunRoot = await realpath(fixture.runRoot);
          const inspectDir = join(await realpath(fixture.work), 'inspect-custom');
          const inspected = await inspectRun({
            runRoot: canonicalRunRoot,
            runId: 'turnkey-custom-dedup',
            output: inspectDir,
          });
          assert.equal(inspected.ok, true, JSON.stringify(inspected));
          const runResultDoc = JSON.parse(
            await readFile(join(inspectDir, 'result.json'), 'utf8'),
          ) as { spec: { subject: { candidateDigest: { hex: string } } } };

          dedupPubServer = await startNativePullRequestPublisherServer({
            runRoot: canonicalRunRoot,
            repositoryRoot: await realpath(fixture.repo),
            repositoryFullName: 'gpustack/runner',
            targetBranch: 'main',
            headBranchPrefix: 'dedup/',
            remoteUrl: await realpath(fixture.bareRemote),
            gitCommitIdentity: {
              name: 'Custom Release Bot',
              email: '9001+custom-bot[bot]@users.noreply.github.com',
            },
          });
          const rawPubBody = Buffer.from(
            JSON.stringify({
              storeId: 'store-dedup',
              runId: 'turnkey-custom-dedup',
              operationId: 'op-dedup',
              dispatchId: 'disp-dedup',
              dispatchGeneration: 1,
              idempotencyKey: 'idem-dedup-1',
              candidateDigest: runResultDoc.spec.subject.candidateDigest.hex,
              baseRevision: headSha,
              sourceRevision: headSha,
              targetBranch: 'main',
              title: `chore: update synced pack\n\n${customSignoff}`,
            }),
            'utf8',
          );
          const pubHttpRes = await fetch(dedupPubServer.url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${dedupPubServer.authToken}`,
              'x-loopwright-signature': signPayload(dedupPubServer.signingSecret, rawPubBody),
            },
            body: rawPubBody,
          });
          assert.equal(pubHttpRes.status, 200);
          const pubBody = (await pubHttpRes.json()) as Record<string, unknown>;
          assert.equal(pubBody['outcome'], 'succeeded');
          const dedupClone = join(fixture.work, 'verify-dedup');
          await git(fixture.work, ['clone', '--branch', 'dedup/main', fixture.bareRemote, dedupClone]);
          const fullBody = await git(dedupClone, ['log', '-1', '--format=%B']);
          const occurrences = fullBody.split('\n').filter(line => line.trim() === customSignoff);
          assert.equal(occurrences.length, 1, `expected single Signed-off-by trailer, got:\n${fullBody}`);
        } finally {
          await dedupPubServer?.close();
          await mockGh.close();
        }
      } finally {
        await openAiServer?.close();
      }
    } finally {
      await githubServer.close();
      await rm(fixture.work, { recursive: true, force: true });
    }
  });

  it('allows candidate writes to explicit .auto-sync/proposal.json, stages PR commit and body, matches managed PR state, and blocks sibling/control-plane writes', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'lw-autosync-proposal-')));
    let openAiServer: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    let mockGh: Awaited<ReturnType<typeof startHttpServer>> | undefined;
    try {
      const repo = join(work, 'repo');
      const bareRemote = join(work, 'remote.git');
      const runRoot = join(work, 'runs');
      await mkdir(repo, { recursive: true });
      await mkdir(bareRemote, { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);

      await git(bareRemote, ['init', '--bare', '-b', 'main']);
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['remote', 'add', 'origin', bareRemote]);

      await mkdir(join(repo, '.auto-sync', 'checks'), { recursive: true });
      await mkdir(join(repo, 'pack', 'cann'), { recursive: true });
      await writeFile(join(repo, '.auto-sync', 'instructions.md'), '# Immutable Auto-Sync Instructions\n', 'utf8');
      await writeFile(join(repo, '.auto-sync', 'other.json'), '{"sibling":"immutable"}\n', 'utf8');
      await writeFile(join(repo, 'pack', 'cann', 'version.txt'), 'v1.0.0\n', 'utf8');
      const verifySh = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'test -f .auto-sync/proposal.json',
        'test "$(cat pack/cann/version.txt)" = "v2.0.0"',
        'test "$(cat .auto-sync/other.json)" = \'{"sibling":"immutable"}\'',
        'test "$(cat .auto-sync/instructions.md)" = "# Immutable Auto-Sync Instructions"',
        '',
      ].join('\n');
      await writeFile(join(repo, '.auto-sync', 'checks', 'verify.sh'), verifySh, { mode: 0o755 });
      await chmod(join(repo, '.auto-sync', 'checks', 'verify.sh'), 0o755);

      const toolFeedbackMessages: string[] = [];
      let turn = 0;
      openAiServer = await startHttpServer(async (req, res) => {
        if (req.method !== 'POST' || !req.url?.startsWith('/v1/chat/completions')) {
          res.writeHead(404);
          res.end();
          return;
        }
        const payload = await readJsonBody(req);
        if (payload['max_tokens'] === 1 && payload['stream'] !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
          return;
        }
        const messages = Array.isArray(payload['messages']) ? payload['messages'] as Record<string, unknown>[] : [];
        const lastMsg = messages.at(-1);
        if (lastMsg && lastMsg['role'] === 'tool' && typeof lastMsg['content'] === 'string') {
          toolFeedbackMessages.push(lastMsg['content']);
        }

        const step = turn++;
        let sseBody: string;
        if (step === 0) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c-other', 'write', {
            path: '.auto-sync/other.json',
            content: '{"sibling":"tampered"}\n',
          });
        } else if (step === 1) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c-instr', 'write', {
            path: '.auto-sync/instructions.md',
            content: '# Tampered\n',
          });
        } else if (step === 2) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c-tp', 'write', {
            path: '.auto-sync/taskpack.yaml',
            content: 'tampered: true\n',
          });
        } else if (step === 3) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c-proposal', 'write', {
            path: '.auto-sync/proposal.json',
            content: `${JSON.stringify({
              schema_version: 1,
              summary: 'Sync CANN package to v2.0.0.',
              upstreams: { cann: 'v2.0.0' },
            }, null, 2)}\n`,
          });
        } else if (step === 4) {
          sseBody = sseToolCall('gpt-4.1-mini', 'c-pack', 'write', {
            path: 'pack/cann/version.txt',
            content: 'v2.0.0\n',
          });
        } else {
          sseBody = sseStop('gpt-4.1-mini', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null }));
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseBody);
      });

      const taskpackYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: cann-autosync
spec:
  goal:
    candidate: Update pack/cann and .auto-sync/proposal.json.
    noChange: Confirm pack/cann is already current.
  instructions:
    - .auto-sync/instructions.md
  models:
    - provider: openai
      id: gpt-4.1-mini
      api: openai-completions
      apiKeyEnv: LLM_TOKEN
      baseUrl: ${openAiServer.url}/v1
      cost:
        input: 2
        output: 8
  scope:
    writable:
      - .auto-sync/proposal.json
      - pack/cann
    protected: []
  upstreams:
    - id: cann
      kind: github-release
      source: gpustack/cann
      watchedPaths:
        - pack/cann
  proposal:
    path: .auto-sync/proposal.json
    requiredFields:
      - schema_version
      - summary
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-json
        implementation: json-artifact.v1
        parameters:
          path: .auto-sync/proposal.json
      - id: verify-pack
        implementation: command.v1
        parameters:
          script: .auto-sync/checks/verify.sh
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-cann/
    titleTemplate: "chore(cann): sync upstream"
  memory:
    directory: .auto-sync/memory/cann
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: true
    commentCommands: []
`;
      await writeFile(join(repo, '.auto-sync', 'taskpack.yaml'), taskpackYaml, 'utf8');
      await git(repo, ['add', '.']);
      await git(repo, ['commit', '-m', 'initial auto-sync repo']);
      const headSha = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['push', 'origin', 'HEAD:refs/heads/main']);

      let createdPrBody = '';
      mockGh = await startHttpServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/repos/gpustack/cann/releases/latest') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ tag_name: 'v2.0.0' }));
          return;
        }
        if (req.method === 'GET' && req.url === '/repos/gpustack/runner') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 901 }));
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/repos/gpustack/runner/pulls')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === 'POST' && req.url === '/repos/gpustack/runner/pulls') {
          const body = await readJsonBody(req);
          const headRef = String(body['head'] ?? '');
          const isMemPr = headRef.startsWith('loopwright/memory/');
          if (!isMemPr) {
            createdPrBody = String(body['body'] ?? '');
          }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            number: isMemPr ? 109 : 108,
            html_url: isMemPr
              ? 'https://github.invalid/gpustack/runner/pull/109'
              : 'https://github.invalid/gpustack/runner/pull/108',
            head: { ref: isMemPr ? headRef : 'loopwright-cann/main', sha: '0'.repeat(40) },
            base: { ref: 'main', sha: headSha },
            title: String(body['title'] ?? 'chore(cann): sync upstream'),
            body: String(body['body'] ?? ''),
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const exitCode = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: repo,
        GITHUB_REPOSITORY: 'gpustack/runner',
        GITHUB_SHA: headSha,
        GITHUB_API_URL: mockGh.url,
        GITHUB_TOKEN: 'ghs_test_token_1234567890abcdef',
        'INPUT_TASKPACK-PATH': '.auto-sync/taskpack.yaml',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'turnkey-autosync-proposal',
        'INPUT_ALLOW-CUSTOM-BASE-URL': 'true',
        'INPUT_REMOTE-URL': bareRemote,
        LLM_TOKEN: 'sk-test-good-token-123456',
      });
      assert.equal(exitCode, 0);

      // Verify all three unauthorized writes under .auto-sync/ were rejected by candidate scope guard
      assert.ok(toolFeedbackMessages.length >= 3);
      assert.match(toolFeedbackMessages[0]!, /outside writable scope/);
      assert.match(toolFeedbackMessages[1]!, /outside writable scope/);
      assert.match(toolFeedbackMessages[2]!, /outside writable scope/);

      // Verify PR body rendered from .auto-sync/proposal.json
      assert.match(createdPrBody, /Sync CANN package to v2\.0\.0\./);
      const directBody = buildNativePullRequestBody({
        runId: 'turnkey-autosync-proposal',
        candidateDigest: 'a'.repeat(64),
        proposalPath: '.auto-sync/proposal.json',
        files: [{
          name: '.auto-sync/proposal.json',
          bytes: Buffer.from(JSON.stringify({ summary: 'Sync CANN package to v2.0.0.' }), 'utf8'),
        }],
        stagedPaths: new Set(['.auto-sync/proposal.json']),
        scrubber: new SecretScrubber(),
      });
      assert.match(directBody, /Sync CANN package to v2\.0\.0\./);

      // Verify pushed PR commit staged .auto-sync/proposal.json + pack/cann/version.txt while leaving sibling & control-plane files untouched
      const prClone = join(work, 'pr-clone');
      await git(work, ['clone', '--branch', 'loopwright-cann/main', bareRemote, prClone]);
      const prHeadSha = await git(prClone, ['rev-parse', 'HEAD']);
      const committedProposal = JSON.parse(await readFile(join(prClone, '.auto-sync', 'proposal.json'), 'utf8')) as Record<string, unknown>;
      assert.equal(committedProposal['summary'], 'Sync CANN package to v2.0.0.');
      assert.equal(await readFile(join(prClone, 'pack', 'cann', 'version.txt'), 'utf8'), 'v2.0.0\n');
      assert.equal(await readFile(join(prClone, '.auto-sync', 'other.json'), 'utf8'), '{"sibling":"immutable"}\n');
      assert.equal(await readFile(join(prClone, '.auto-sync', 'instructions.md'), 'utf8'), '# Immutable Auto-Sync Instructions\n');
      assert.equal(await readFile(join(prClone, '.auto-sync', 'taskpack.yaml'), 'utf8'), taskpackYaml);

      // Verify checkManagedPrMatchesDiscoveredState reads .auto-sync/proposal.json from the PR head commit
      await git(repo, ['fetch', 'origin', 'loopwright-cann/main']);
      const loadedManifest = await loadDeclarativeTaskpack({
        manifestPath: '.auto-sync/taskpack.yaml',
        repositoryRoot: repo,
      });
      const matchesDiscovered = await checkManagedPrMatchesDiscoveredState({
        repositoryRoot: repo,
        repositoryFullName: 'gpustack/runner',
        openManagedPr: {
          number: 108,
          htmlUrl: 'https://github.invalid/gpustack/runner/pull/108',
          headRef: 'loopwright-cann/main',
          headSha: prHeadSha,
          baseRef: 'main',
          baseSha: headSha,
          title: 'chore(cann): sync upstream',
          body: createdPrBody,
        },
        manifest: loadedManifest,
        records: [{
          upstreamId: 'cann',
          status: 'available',
          version: 'v2.0.0',
        }],
      });
      assert.equal(matchesDiscovered, true);
    } finally {
      await openAiServer?.close();
      await mockGh?.close();
      await rm(work, { recursive: true, force: true });
    }
  });
});
