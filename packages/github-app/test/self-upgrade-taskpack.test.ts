import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { loadTrustedConfiguration, stepNext } from '@loopwright/controller';
import { isWritablePath } from '@loopwright/core';
import {
  checkManagedPrMatchesDiscoveredState,
  compileDeclarativeTaskpack,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  loadDeclarativeTaskpack,
  loadPiModelsJson,
  openStagedTaskpackStepGate,
  resolveEffectiveTaskpackSandboxPolicy,
  runActionCli,
  stageTaskpackForStep,
  type TaskpackUpstreamRecord,
} from '../src/index.js';
import {
  REPO_ROOT,
  CAN_RUN_KERNEL_CONTAINMENT,
  type TargetVersionsPayload,
  loadPreflightModule,
  withTempDir,
  buildSyntheticLockfile,
  createMiniSelfUpgradeRepo,
  stageAndApplyCandidateUpgrade,
  runVerifyScript,
} from './self-upgrade-fixtures.js';

describe('Self-upgrade dogfooding Taskpack, preflight stager, and OS-contained command.v1 gate', () => {
  it('compiles committed .loopwright/taskpack.yaml in candidate and no-change modes with strict scope boundaries', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir);
      const baseline = await preflight.auditBaselineParity(repoRoot);
      assert.equal(baseline.piBaseline, '1.5.0');
      assert.equal(baseline.yamlBaseline, '2.9.0');
      assert.equal(baseline.lockfileBytes <= 900 * 1024, true);
    });

    const manifest = await loadDeclarativeTaskpack({
      manifestPath: '.loopwright/taskpack.yaml',
      repositoryRoot: REPO_ROOT,
    });
    assert.equal(manifest.metadata.name, 'self-upgrade');
    assert.equal(manifest.spec.sandbox, undefined);
    assert.equal(manifest.spec.limits?.commandTimeoutSeconds, 900);
    assert.deepEqual(manifest.spec.triggers.commentCommands, ['retry', 'revise']);
    assert.equal(manifest.spec.upstreams.length, 7);

    // Omitted spec.sandbox resolves to direct-dedicated on GitHub Actions and host OS sandbox locally
    const ghaPolicy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
      workspaceRoot: REPO_ROOT,
      relativeTaskpackPath: '.loopwright/taskpack.yaml',
      env: { GITHUB_ACTIONS: 'true' },
    });
    assert.deepEqual(ghaPolicy.preferredBackends, ['direct-dedicated']);
    assert.equal(ghaPolicy.allowDedicatedDirectOverride, true);

    const localPolicy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
      workspaceRoot: REPO_ROOT,
      relativeTaskpackPath: '.loopwright/taskpack.yaml',
      env: {},
    });
    assert.equal(localPolicy.preferredBackends, undefined);
    assert.equal(localPolicy.allowDedicatedDirectOverride, undefined);

    const checkEntry = manifest.spec.verification.localChecks.find(c => c.id === 'self-upgrade-verify');
    const allowedEnv = checkEntry?.parameters?.['env'] as readonly string[] | undefined;
    assert.equal(allowedEnv?.includes('SELF_UPGRADE_RUN_ROOT'), true);
    assert.equal(allowedEnv?.includes('SELF_UPGRADE_STAGE_DIR'), true);

    const candidateCompiled = await compileDeclarativeTaskpack(manifest, {
      mode: 'candidate',
      executionMode: 'delegated',
      repository: 'gpustack/loopwright',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      repositoryRoot: REPO_ROOT,
      taskpackPath: '.loopwright/taskpack.yaml',
      budgets: DEFAULT_HOST_BUDGETS,
    });
    const noChangeCompiled = await compileDeclarativeTaskpack(manifest, {
      mode: 'no-change',
      executionMode: 'delegated',
      repository: 'gpustack/loopwright',
      baseRevision: 'a'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      repositoryRoot: REPO_ROOT,
      taskpackPath: '.loopwright/taskpack.yaml',
      budgets: DEFAULT_HOST_BUDGETS,
    });

    assert.equal(candidateCompiled.localCommandGates?.length, 1);
    assert.equal(candidateCompiled.localCommandGates?.[0]?.timeoutSeconds, 900);
    assert.equal(candidateCompiled.localCommandGates?.[0]?.script, '.loopwright/checks/verify.sh');
    assert.deepEqual(noChangeCompiled.config.spec.task.spec.acceptance.required, ['taskpack-no-change']);

    const contract = candidateCompiled.config.spec.task;
    const writablePaths = [
      '.loopwright/proposal.json',
      'package-lock.json',
      'packages/agent-pi/package.json',
      'packages/agent-pi/src/host-session.ts',
      'packages/cli/package.json',
      'packages/controller/src/index.ts',
      'packages/decisions/src/schema.ts',
      'packages/github-app/src/schema.ts',
      'docs/development.md',
    ];
    for (const rel of writablePaths) {
      const check = isWritablePath(contract, rel);
      assert.equal(check.ok && check.value, true, `expected ${rel} to be writable`);
    }

    const protectedPaths = [
      '.loopwright/taskpack.yaml',
      '.loopwright/instructions.md',
      '.loopwright/checks/verify.sh',
      'package.json',
      'scripts/prepare-self-upgrade.mjs',
      'action.yml',
      '.github/workflows/ci.yml',
      'packages/core/src/contracts.ts',
      'packages/state/src/index.ts',
      'packages/memory/src/index.ts',
      'packages/taskpack-runner/src/index.ts',
      'packages/agent-pi/qualification/run.ts',
      'packages/controller/qualification/run.ts',
      'packages/cli/src/closure.ts',
      'packages/cli/src/failure-matrix.ts',
      'docs/contribute/internals.md',
    ];
    for (const rel of protectedPaths) {
      const check = isWritablePath(contract, rel);
      assert.equal(check.ok && check.value, false, `expected ${rel} to be non-writable`);
    }
  });

  it('evaluates all SemVer eligibility, partial publish, rollback, prerelease, missing-version hash, and streaming >256 KiB cap branches', async () => {
    const preflight = await loadPreflightModule();
    const baselineByUpstream: Record<string, string> = {
      'pi-coding-agent': '1.5.0',
      'pi-ai': '1.5.0',
      'pi-agent-core': '1.5.0',
      'pi-mcp': '1.5.0',
      'pi-codemode': '1.5.0',
      'pi-tui': '1.5.0',
      yaml: '2.9.0',
    };
    const makeRecords = (overrides: Readonly<Record<string, string>>): readonly TaskpackUpstreamRecord[] =>
      preflight.ALL_UPSTREAM_IDS.map(id => {
        const version = overrides[id] ?? baselineByUpstream[id]!;
        return {
          upstreamId: id,
          status: version === baselineByUpstream[id] ? 'up_to_date' : 'available',
          version,
        };
      });

    // 1) All up_to_date -> no-change
    const unchanged = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({}),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(unchanged.recommendedMode, 'no-change');
    assert.equal(unchanged.actionMode, 'no-change');
    assert.equal(unchanged.upstreamRecords.every(r => r.status === 'up_to_date'), true);

    // 2) Aligned Pi bump -> candidate
    const alignedPi = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords(
        Object.fromEntries(preflight.PI_UPSTREAM_IDS.map(id => [id, '1.6.0'])),
      ),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(alignedPi.recommendedMode, 'candidate');
    assert.equal(alignedPi.targetPiVersion, '1.6.0');
    assert.equal(alignedPi.targetYamlVersion, '2.9.0');
    for (const id of preflight.PI_UPSTREAM_IDS) {
      const rec = alignedPi.upstreamRecords.find(r => r.upstreamId === id);
      assert.equal(rec?.status, 'available');
      assert.equal(rec?.version, '1.6.0');
      assert.equal(rec?.reason?.includes('stageDir=/tmp/stage-test'), true);
    }

    // 3) Partial Pi publish + unchanged YAML -> blocked
    const partialPiOnly = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({
        'pi-coding-agent': '1.6.0',
        'pi-ai': '1.6.0',
        'pi-agent-core': '1.6.0',
        'pi-mcp': '1.6.0',
        'pi-codemode': '1.6.0',
        'pi-tui': '1.5.0',
      }),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(partialPiOnly.recommendedMode, 'blocked');
    assert.equal(partialPiOnly.upstreamRecords.some(r => r.status === 'blocked'), true);

    // 4) Partial Pi publish + YAML bump -> YAML-only candidate (Pi held at baseline)
    const partialPiWithYaml = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({
        'pi-coding-agent': '1.6.0',
        'pi-ai': '1.5.0',
        yaml: '2.10.0',
      }),
      stageDir: '/tmp/stage-test',
    });
    assert.equal(partialPiWithYaml.recommendedMode, 'candidate');
    assert.equal(partialPiWithYaml.targetPiVersion, '1.5.0');
    assert.equal(partialPiWithYaml.targetYamlVersion, '2.10.0');
    const yamlRec = partialPiWithYaml.upstreamRecords.find(r => r.upstreamId === 'yaml');
    assert.equal(yamlRec?.status, 'available');
    assert.equal(yamlRec?.version, '2.10.0');
    for (const id of preflight.PI_UPSTREAM_IDS) {
      const piRec = partialPiWithYaml.upstreamRecords.find(r => r.upstreamId === id);
      assert.equal(piRec?.status, 'up_to_date');
      assert.equal(piRec?.version, '1.5.0');
    }

    // 5) Aligned rollback -> rejected (blocked)
    const alignedRollback = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords(
        Object.fromEntries(preflight.PI_UPSTREAM_IDS.map(id => [id, '1.4.9'])),
      ),
    });
    assert.equal(alignedRollback.recommendedMode, 'blocked');
    assert.equal(alignedRollback.reasons.some(msg => msg.includes('rollback rejected')), true);

    // 6) Prerelease tag -> rejected (blocked)
    const prerelease = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: makeRecords({ yaml: '2.10.0-rc.1' }),
    });
    assert.equal(prerelease.recommendedMode, 'blocked');
    assert.equal(prerelease.reasons.some(msg => msg.includes('non-canonical SemVer')), true);

    // 7) Missing-version 16-hex SHA hash from http-json -> rejected (blocked)
    const manifest = await loadDeclarativeTaskpack({
      manifestPath: '.loopwright/taskpack.yaml',
      repositoryRoot: REPO_ROOT,
    });
    const fixturesWithMissingVersion: Record<string, unknown> = Object.fromEntries(
      preflight.ALL_UPSTREAM_IDS.map(id => [
        id,
        id === 'yaml' ? { dist_tag: 'broken-no-version-field' } : { version: '1.5.0' },
      ]),
    );
    const discoveredMissingVersion = await preflight.discoverNpmUpstreams({
      manifest,
      baselineByUpstream,
      registryFixtures: fixturesWithMissingVersion,
    });
    const missingHashEval = preflight.evaluateUpstreamEligibility({
      baselineByUpstream,
      discoveredRecords: discoveredMissingVersion,
    });
    assert.equal(missingHashEval.recommendedMode, 'blocked');
    assert.equal(missingHashEval.reasons.some(msg => msg.includes('non-canonical SemVer')), true);

    // 8) Incremental streaming >256 KiB response cancels mid-stream without buffering full payload
    let chunksPulled = 0;
    let streamCancelled = false;
    const chunkSize = 64 * 1024;
    const totalChunks = 12; // 768 KiB total if uncancelled
    const oversizedFetch: typeof globalThis.fetch = async url => {
      const urlText = String(url);
      if (!urlText.endsWith('/yaml/latest')) {
        return new Response(JSON.stringify({ version: '1.5.0' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (chunksPulled >= totalChunks) {
              controller.close();
              return;
            }
            chunksPulled += 1;
            controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
          },
          cancel() {
            streamCancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, { status: 200 });
    };
    const streamedRecords = await preflight.discoverNpmUpstreams({
      manifest,
      baselineByUpstream,
      fetchImpl: oversizedFetch,
    });
    const yamlStreamRec = streamedRecords.find(r => r.upstreamId === 'yaml');
    assert.equal(yamlStreamRec?.status, 'failed');
    assert.equal(yamlStreamRec?.reason?.includes(`${preflight.MAX_HTTP_JSON_BYTES} bytes`), true);
    assert.equal(streamCancelled, true, 'oversized HTTP stream must be cancelled incrementally');
    assert.equal(chunksPulled <= 5, true, `expected <=5 64KiB chunks read before cancel, got ${chunksPulled}`);
  });

  it('fails nonzero on malformed JSON, invalid schema, or drifted .loopwright/proposal.json and stages read-only candidate bundles', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const { repoRoot, headSha } = await createMiniSelfUpgradeRepo(dir);
      const proposalPath = join(repoRoot, '.loopwright/proposal.json');
      const originalProposalRaw = await readFile(proposalPath, 'utf8');
      const originalProposal = JSON.parse(originalProposalRaw) as Record<string, unknown>;

      // 1) Malformed truncated JSON in .loopwright/proposal.json -> nonzero failure
      await writeFile(proposalPath, '{"schema_version": 1, "summary": "broken"\n', { mode: 0o600 });
      const malformedRun = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
        { encoding: 'utf8' },
      );
      assert.notEqual(malformedRun.status, 0);
      assert.equal(malformedRun.stderr.includes('Invalid JSON in ".loopwright/proposal.json"'), true);

      // 2) Invalid schema (schema_version !== 1) in .loopwright/proposal.json -> nonzero failure
      await writeFile(
        proposalPath,
        `${JSON.stringify({ ...originalProposal, schema_version: 2 }, null, 2)}\n`,
        { mode: 0o600 },
      );
      const schemaInvalidRun = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
        { encoding: 'utf8' },
      );
      assert.notEqual(schemaInvalidRun.status, 0);
      assert.equal(schemaInvalidRun.stderr.includes('schema_version must be 1'), true);

      // 3) Drift .loopwright/proposal.json yaml version without updating packages/cli/package.json -> nonzero failure
      const driftedProposal = {
        ...originalProposal,
        upstreams: {
          ...(originalProposal['upstreams'] as Record<string, unknown>),
          yaml: { package: 'yaml', version: '2.8.0' },
        },
      };
      await writeFile(proposalPath, `${JSON.stringify(driftedProposal, null, 2)}\n`, { mode: 0o600 });
      const cliDriftRun = spawnSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/prepare-self-upgrade.mjs'), '--repo', repoRoot, '--offline-check'],
        { encoding: 'utf8' },
      );
      assert.notEqual(cliDriftRun.status, 0);
      assert.equal(cliDriftRun.stderr.includes('drifts from proposal.upstreams'), true);

      // Restore clean proposal and stage a read-only candidate bundle
      await writeFile(proposalPath, originalProposalRaw, { mode: 0o600 });
      const stageDir = join(dir, 'staged-bundle');
      const prepared = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir,
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.10.0' : '1.6.0' },
          ]),
        ),
        lockfileBuilder: async ({ targetVersions }) => Buffer.from(
          buildSyntheticLockfile({
            piVersion: targetVersions.upstreams['pi-coding-agent']!.version,
            yamlVersion: targetVersions.upstreams['yaml']!.version,
          }),
          'utf8',
        ),
      });

      assert.equal(prepared.recommendedMode, 'candidate');
      assert.notEqual(prepared.staged, null);
      const targetInfo = await stat(prepared.staged!.targetVersionsPath);
      const lockInfo = await stat(prepared.staged!.candidateLockPath);
      const dirInfo = await stat(prepared.staged!.stageDir);
      assert.equal(targetInfo.mode & 0o222, 0, 'target-versions.json must be read-only');
      assert.equal(lockInfo.mode & 0o222, 0, 'package-lock.candidate.json must be read-only');
      assert.equal(dirInfo.mode & 0o222, 0, 'stage directory must be read-only');

      // Verify checkManagedPrMatchesDiscoveredState matches a committed proposal carrying those versions
      const prHeadProposal = JSON.stringify(prepared.evaluation!.targetVersions, null, 2);
      await writeFile(proposalPath, `${prHeadProposal}\n`, { mode: 0o600 });
      spawnSync('git', ['add', '.loopwright/proposal.json'], { cwd: repoRoot, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'chore: simulated managed PR head'], { cwd: repoRoot, stdio: 'ignore' });
      const prHeadSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
      spawnSync('git', ['reset', '--hard', headSha], { cwd: repoRoot, stdio: 'ignore' });

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
      });
      const prMatches = await checkManagedPrMatchesDiscoveredState({
        repositoryRoot: repoRoot,
        repositoryFullName: 'gpustack/loopwright',
        manifest,
        openManagedPr: {
          number: 42,
          htmlUrl: 'https://github.com/gpustack/loopwright/pull/42',
          headRef: 'loopwright-self-upgrade-1',
          headSha: prHeadSha,
          baseRef: 'main',
          baseSha: headSha,
          title: 'chore(deps): self-upgrade runtime dependencies',
          body: 'Managed PR fixture',
        },
        records: prepared.upstreamRecords,
      });
      assert.equal(prMatches, true);
    });
  });

  it('enforces verify.sh staged-bundle binding, compiler/git-url lockfile guards, workspace-entry skew, size cap, and GITHUB_ACTIONS refusal', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir, {
        emitBuildCanary: true,
      });
      const hostNodeModules = join(REPO_ROOT, 'node_modules');
      const stageDir = join(dir, 'stage-guards');

      // Stage a valid 1.6.0 / 2.10.0 bundle first
      const baselineProposalRaw = await readFile(join(repoRoot, '.loopwright/proposal.json'), 'utf8');
      const baselineLockRaw = await readFile(join(repoRoot, 'package-lock.json'), 'utf8');
      const baselineCliPkgRaw = await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8');
      const baselineAgentPiPkgRaw = await readFile(join(repoRoot, 'packages/agent-pi/package.json'), 'utf8');

      // 1) Refuse SELF_UPGRADE_TEST_NODE_MODULES when GITHUB_ACTIONS=true
      const ghActionsRefused = runVerifyScript(repoRoot, {
        GITHUB_ACTIONS: 'true',
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(ghActionsRefused.status, 0);
      assert.equal(ghActionsRefused.stderr.includes('GITHUB_ACTIONS'), true);
      assert.equal(ghActionsRefused.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 2) Reject unchanged baseline manifests even if someone stages matching baseline target-versions.json
      const unchangedStageDir = join(dir, 'stage-unchanged');
      await preflight.stageCandidateBundle({
        repoRoot,
        stageDir: unchangedStageDir,
        targetVersions: preflight.buildTargetVersionsPayload('1.5.0', '2.9.0'),
        lockfileBuilder: async () => Buffer.from(baselineLockRaw, 'utf8'),
      });
      const unchangedCandidateRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: unchangedStageDir,
      });
      assert.notEqual(unchangedCandidateRes.status, 0);
      assert.equal(unchangedCandidateRes.stderr.includes('do not advance'), true);
      assert.equal(unchangedCandidateRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // Prepare valid upgraded candidate state (pi=1.6.0, yaml=2.10.0)
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot,
        candidateDir: repoRoot,
        stageDir,
        piVersion: '1.6.0',
        yamlVersion: '2.10.0',
        nestedPiTransitiveYamlVersion: '2.9.0',
      });
      const validLockRaw = await readFile(join(repoRoot, 'package-lock.json'), 'utf8');
      const validCliPkgRaw = await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8');
      const validAgentPiPkgRaw = await readFile(join(repoRoot, 'packages/agent-pi/package.json'), 'utf8');

      // 3) Reject scripts/postinstall injection in packages/cli/package.json BEFORE running candidate build
      const tamperedScriptsPkg = {
        ...(JSON.parse(validCliPkgRaw) as Record<string, unknown>),
        scripts: { postinstall: 'echo pwned', test: 'true' },
      };
      await writeFile(join(repoRoot, 'packages/cli/package.json'), `${JSON.stringify(tamperedScriptsPkg, null, 2)}\n`, { mode: 0o600 });
      const scriptTamperRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(scriptTamperRes.status, 0);
      assert.equal(scriptTamperRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await writeFile(join(repoRoot, 'packages/cli/package.json'), validCliPkgRaw, { mode: 0o600 });

      // 4) Reject @earendil-works/pi-* version skew in packages/agent-pi/package.json
      const parsedAgentPi = JSON.parse(validAgentPiPkgRaw) as { dependencies: Record<string, string> };
      parsedAgentPi.dependencies['@earendil-works/pi-ai'] = '1.6.1';
      await writeFile(join(repoRoot, 'packages/agent-pi/package.json'), `${JSON.stringify(parsedAgentPi, null, 2)}\n`, { mode: 0o600 });
      const piSkewRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(piSkewRes.status, 0);
      assert.equal(piSkewRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);
      await writeFile(join(repoRoot, 'packages/agent-pi/package.json'), validAgentPiPkgRaw, { mode: 0o600 });

      // 5) Reject workspace-entry yaml mismatch (packages["packages/cli"].dependencies.yaml != 2.10.0 while hoisted stays 2.10.0)
      const lockPath = join(repoRoot, 'package-lock.json');
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          directCliYamlOverride: '2.9.0',
        }),
        { mode: 0o600 },
      );
      const wsEntrySkewRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(wsEntrySkewRes.status, 0);
      assert.equal(wsEntrySkewRes.stderr.includes("packages/cli.dependencies['yaml']"), true);
      assert.equal(wsEntrySkewRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 6) Reject hoisted resolution yaml mismatch (node_modules/yaml=2.9.0 while workspace entry is 2.10.0)
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          hoistedYamlOverride: '2.9.0',
        }),
        { mode: 0o600 },
      );
      const hoistedSkewRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(hoistedSkewRes.status, 0);
      assert.equal(hoistedSkewRes.stderr.includes('direct resolution for packages/cli -> yaml'), true);
      assert.equal(hoistedSkewRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 7) Reject forged compiler link hijack (node_modules/typescript -> packages/cli/fake-typescript)
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          forgedTypescriptLinkTarget: 'packages/cli/fake-typescript',
        }),
        { mode: 0o600 },
      );
      const compilerHijackRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(compilerHijackRes.status, 0);
      assert.equal(compilerHijackRes.stderr.includes('unauthorized link entry'), true);
      assert.equal(compilerHijackRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 8) Reject unapproved git+https:// resolved URL in package-lock.json
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          forgedYamlResolvedUrl: 'git+https://example.invalid/yaml.git#deadbeef',
        }),
        { mode: 0o600 },
      );
      const gitUrlRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(gitUrlRes.status, 0);
      assert.equal(gitUrlRes.stderr.includes('unapproved resolved source'), true);
      assert.equal(gitUrlRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 9) Reject candidate lockfile whose SHA-256 differs from staged package-lock.candidate.json
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          nestedPiTransitiveYamlVersion: '2.9.1',
        }),
        { mode: 0o600 },
      );
      const shaMismatchRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(shaMismatchRes.status, 0);
      assert.equal(shaMismatchRes.stderr.includes('does not match trusted staged package-lock.candidate.json'), true);
      assert.equal(shaMismatchRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 10) Reject oversized package-lock.json (> 900 KiB)
      await writeFile(
        lockPath,
        buildSyntheticLockfile({
          piVersion: '1.6.0',
          yamlVersion: '2.10.0',
          padBytes: 910 * 1024,
        }),
        { mode: 0o600 },
      );
      const oversizedRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(oversizedRes.status, 0);
      assert.equal(oversizedRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), false);

      // 11) Restore exact staged lockfile (with nested transitive yaml=2.9.0) and verify execution behavior
      await writeFile(lockPath, validLockRaw, { mode: 0o600 });
      const nestedAllowedRes = runVerifyScript(repoRoot, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: repoRoot,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      if (CAN_RUN_KERNEL_CONTAINMENT) {
        assert.equal(nestedAllowedRes.status, 0, `expected verify.sh to pass: ${nestedAllowedRes.stderr}`);
        assert.equal(nestedAllowedRes.stderr.includes('CANDIDATE_BUILD_EXECUTED_CANARY'), true);
      } else {
        assert.notEqual(nestedAllowedRes.status, 0);
        assert.equal(nestedAllowedRes.stderr.includes('failing closed'), true);
      }

      // Restore baseline files cleanly
      await writeFile(join(repoRoot, '.loopwright/proposal.json'), baselineProposalRaw, { mode: 0o600 });
      await writeFile(lockPath, baselineLockRaw, { mode: 0o600 });
      await writeFile(join(repoRoot, 'packages/cli/package.json'), baselineCliPkgRaw, { mode: 0o600 });
      await writeFile(join(repoRoot, 'packages/agent-pi/package.json'), baselineAgentPiPkgRaw, { mode: 0o600 });
    });
  });

  it('contains candidate execution inside OS sandbox with positive uncontained controls and kernel denial evidence', async () => {
    if (!CAN_RUN_KERNEL_CONTAINMENT) {
      // On hosts where AppArmor blocks unprivileged userns (e.g. unconfigured Linux CI), verify fail-closed refusal.
      const preflight = await loadPreflightModule();
      await withTempDir(async dir => {
        const { repoRoot } = await createMiniSelfUpgradeRepo(dir);
        const stageDir = join(dir, 'stage-fail-closed');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot,
          candidateDir: repoRoot,
          stageDir,
        });
        const res = runVerifyScript(repoRoot, {
          SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
          SELF_UPGRADE_TEST_NODE_MODULES: join(REPO_ROOT, 'node_modules'),
          SELF_UPGRADE_REPO_ROOT: repoRoot,
          SELF_UPGRADE_STAGE_DIR: stageDir,
        });
        assert.notEqual(res.status, 0);
        assert.equal(res.stderr.includes('failing closed'), true);
      });
      return;
    }

    const preflight = await loadPreflightModule();
    const hostNodeModules = join(REPO_ROOT, 'node_modules');

    // Case A: Disjoint runRoot/.taskpack-canary/secrets.json AND real $HOME canary read attempts -> kernel-denied
    await withTempDir(async dir => {
      const disjointRunRoot = await mkdtemp(join(await realpath(tmpdir()), 'lw-disjoint-runroot-'));
      const homeCanaryPath = join(await realpath(homedir()), `.lw-self-upgrade-home-canary-${randomUUID()}`);
      try {
        const canaryDir = join(disjointRunRoot, '.taskpack-canary');
        await mkdir(canaryDir, { recursive: true, mode: 0o700 });
        const runRootSecretPath = join(canaryDir, 'secrets.json');
        await writeFile(runRootSecretPath, '{"secret":"RUNROOT_TOP_SECRET"}\n', { mode: 0o600 });
        await writeFile(homeCanaryPath, 'HOME_CREDENTIAL_CANARY\n', { mode: 0o600 });

        const secretProbeBody = `import { readFileSync } from 'node:fs';
let blockedCount = 0;
for (const [label, p] of [['runroot', ${JSON.stringify(runRootSecretPath)}], ['home', ${JSON.stringify(homeCanaryPath)}]]) {
  try {
    const leaked = readFileSync(p, 'utf8');
    process.stderr.write('LEAKED_' + label + '=' + leaked + '\\n');
    process.exit(0);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
    process.stderr.write('CANARY_ERR_CODE_' + label + '=' + code + '\\n');
    blockedCount += 1;
  }
}
process.exit(blockedCount === 2 ? 42 : 0);
`;
        // Positive uncontained control: reading both files succeeds (exits 0 with LEAKED_runroot)
        const uncontainedRead = spawnSync(process.execPath, ['--input-type=module', '-e', secretProbeBody], {
          encoding: 'utf8',
        });
        assert.equal(uncontainedRead.status, 0);
        assert.equal(uncontainedRead.stderr.includes('LEAKED_runroot='), true);

        const { repoRoot: readEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
          testScriptBody: secretProbeBody,
        });
        const stageDir = join(dir, 'stage-read');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: readEscapeRepo,
          candidateDir: readEscapeRepo,
          stageDir,
        });

        const readEscapeRes = runVerifyScript(readEscapeRepo, {
          SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
          SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
          SELF_UPGRADE_REPO_ROOT: readEscapeRepo,
          SELF_UPGRADE_STAGE_DIR: stageDir,
          SELF_UPGRADE_RUN_ROOT: disjointRunRoot,
        });
        assert.notEqual(readEscapeRes.status, 0);
        assert.equal(readEscapeRes.stderr.includes('LEAKED_'), false);
        assert.match(readEscapeRes.stderr, /CANARY_ERR_CODE_runroot=(EPERM|EACCES|ENOENT)/);
        assert.match(readEscapeRes.stderr, /CANARY_ERR_CODE_home=(EPERM|EACCES|ENOENT)/);
      } finally {
        await rm(homeCanaryPath, { force: true });
        await rm(disjointRunRoot, { recursive: true, force: true });
      }
    });

    // Case B: Candidate test attempts to mutate README.md in the base repository checkout -> kernel-denied
    await withTempDir(async dir => {
      const targetPlaceholder = '__BASE_README_TARGET__';
      const { repoRoot: writeEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
        testScriptBody: `import { writeFileSync } from 'node:fs';
try {
  writeFileSync(${JSON.stringify(targetPlaceholder)}, 'mutated-by-candidate\\n');
  process.stderr.write('CHECKOUT_WRITE_SUCCEEDED\\n');
  process.exit(0);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
  process.stderr.write('CHECKOUT_WRITE_ERR_CODE=' + code + '\\n');
  process.exit(43);
}
`,
      });
      const realBaseReadme = join(writeEscapeRepo, 'README.md');
      const runTestsPath = join(writeEscapeRepo, 'scripts/run-tests.mjs');
      const updatedRunTests = (await readFile(runTestsPath, 'utf8')).replace(targetPlaceholder, realBaseReadme);
      await writeFile(runTestsPath, updatedRunTests, { mode: 0o600 });
      spawnSync('git', ['add', 'scripts/run-tests.mjs'], { cwd: writeEscapeRepo, stdio: 'ignore' });
      spawnSync('git', ['commit', '-m', 'test: attempt checkout write'], { cwd: writeEscapeRepo, stdio: 'ignore' });

      const stageDir = join(dir, 'stage-write');
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot: writeEscapeRepo,
        candidateDir: writeEscapeRepo,
        stageDir,
      });

      const writeEscapeRes = runVerifyScript(writeEscapeRepo, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: writeEscapeRepo,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(writeEscapeRes.status, 0);
      assert.equal(writeEscapeRes.stderr.includes('CHECKOUT_WRITE_SUCCEEDED'), false);
      assert.match(writeEscapeRes.stderr, /CHECKOUT_WRITE_ERR_CODE=(EPERM|EACCES|EROFS|ENOENT)/);
      assert.equal(await readFile(realBaseReadme, 'utf8'), '# Fixture Loopwright Repo\n');
    });

    // Case C: Candidate CLI during `closure --verify-failures` attempts to overwrite `scripts/run-tests.mjs` -> OS read-only denial (S3)
    await withTempDir(async dir => {
      const { repoRoot: rewriteGateRepo } = await createMiniSelfUpgradeRepo(dir, {
        cliMainBody: `import { writeFileSync } from 'node:fs';
try {
  writeFileSync('scripts/run-tests.mjs', 'process.exit(0);\\n');
  process.stderr.write('GATE_REWRITE_SUCCEEDED\\n');
  process.exit(0);
} catch (err) {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
  process.stderr.write('GATE_REWRITE_ERR_CODE=' + code + '\\n');
  process.exit(44);
}
`,
        testScriptBody: `process.exit(99);\n`,
      });
      const stageDir = join(dir, 'stage-gate-rewrite');
      await stageAndApplyCandidateUpgrade({
        preflight,
        repoRoot: rewriteGateRepo,
        candidateDir: rewriteGateRepo,
        stageDir,
      });

      const rewriteRes = runVerifyScript(rewriteGateRepo, {
        SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
        SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
        SELF_UPGRADE_REPO_ROOT: rewriteGateRepo,
        SELF_UPGRADE_STAGE_DIR: stageDir,
      });
      assert.notEqual(rewriteRes.status, 0);
      assert.equal(rewriteRes.stderr.includes('GATE_REWRITE_SUCCEEDED'), false);
      assert.match(rewriteRes.stderr, /GATE_REWRITE_ERR_CODE=(EROFS|EPERM|EACCES)/);
    });

    // Case D: Controlled reachable host loopback TCP service -> positive uncontained connect succeeds, contained compile-and-lint connect is kernel-denied (S7 + S11)
    await withTempDir(async dir => {
      let connectionHits = 0;
      const hostLoopbackServer = net.createServer(socket => {
        connectionHits += 1;
        socket.end('HOST_SERVICE_OK');
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        hostLoopbackServer.once('error', rejectListen);
        hostLoopbackServer.listen(0, '127.0.0.1', () => resolveListen());
      });
      try {
        const addr = hostLoopbackServer.address();
        assert.equal(addr !== null && typeof addr === 'object', true);
        const hostPort = (addr as net.AddressInfo).port;

        const tcpProbeBody = `import net from 'node:net';
await new Promise((resolveConn, rejectConn) => {
  const socket = net.connect({ host: '127.0.0.1', port: ${String(hostPort)} });
  socket.setTimeout(2500);
  socket.once('data', chunk => {
    process.stderr.write('HOST_LOOPBACK_CONNECTED=' + chunk.toString('utf8') + '\\n');
    socket.destroy();
    resolveConn(undefined);
  });
  socket.once('timeout', () => {
    socket.destroy();
    process.stderr.write('NET_ERR_CODE=ETIMEDOUT\\n');
    rejectConn(new Error('timeout'));
  });
  socket.once('error', err => {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN';
    process.stderr.write('NET_ERR_CODE=' + code + '\\n');
    rejectConn(err);
  });
});
`;
        // Use async spawn so the parent event loop services hostLoopbackServer in real time
        const spawnAsync = (
          cmd: string,
          args: readonly string[],
          opts: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv },
        ): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> =>
          new Promise((resolveProc, rejectProc) => {
            const child = spawn(cmd, args, {
              cwd: opts.cwd,
              env: opts.env,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', chunk => { out += String(chunk); });
            child.stderr.on('data', chunk => { err += String(chunk); });
            child.once('error', rejectProc);
            child.once('close', code => resolveProc({ status: code, stdout: out, stderr: err }));
          });

        // Positive uncontained control: connecting to 127.0.0.1:hostPort succeeds and delivers data
        const uncontainedNet = await spawnAsync(
          process.execPath,
          ['--input-type=module', '-e', tcpProbeBody],
          { env: process.env },
        );
        assert.equal(uncontainedNet.status, 0);
        assert.equal(uncontainedNet.stderr.includes('HOST_LOOPBACK_CONNECTED'), true);
        assert.equal(connectionHits, 1);

        connectionHits = 0;
        const { repoRoot: netEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
          buildScriptBody: tcpProbeBody,
        });
        const stageDir = join(dir, 'stage-net');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: netEscapeRepo,
          candidateDir: netEscapeRepo,
          stageDir,
        });

        const verifyPath = join(REPO_ROOT, '.loopwright/checks/verify.sh');
        const netEscapeRes = await spawnAsync(
          '/bin/bash',
          [verifyPath],
          {
            cwd: netEscapeRepo,
            env: {
              PATH: '/usr/local/bin:/usr/bin:/bin',
              NODE_BIN_DIR: dirname(process.execPath),
              HOME: netEscapeRepo,
              TMPDIR: tmpdir(),
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              LOOPWRIGHT_CANDIDATE_DIR: netEscapeRepo,
              LOOPWRIGHT_CHECK_ID: 'self-upgrade-verify',
              SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
              SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
              SELF_UPGRADE_REPO_ROOT: netEscapeRepo,
              SELF_UPGRADE_STAGE_DIR: stageDir,
            },
          },
        );
        assert.notEqual(netEscapeRes.status, 0, 'compile-and-lint stage (network_mode=none) must deny loopback TCP inside OS containment');
        assert.equal(connectionHits, 0, 'contained compile-and-lint candidate must not reach host loopback service');
        assert.equal(netEscapeRes.stderr.includes('HOST_LOOPBACK_CONNECTED'), false);
        assert.match(netEscapeRes.stderr, /NET_ERR_CODE=(EPERM|EACCES|ECONNREFUSED|ENETUNREACH)/);
      } finally {
        await new Promise<void>(resolveClose => hostLoopbackServer.close(() => resolveClose()));
      }
    });

    // Case E: Separate host Node process carrying a secret environment canary -> positive uncontained
    // inspection/signaling succeeds, while contained verify.sh execution is kernel-denied (KERN_PROCARGS2 / /proc & kill)
    await withTempDir(async dir => {
      const hostCanarySecret = `HOST_PROC_CANARY_${randomUUID()}`;
      const hostVictim = spawn(
        process.execPath,
        ['-e', 'process.stdout.write("READY\\n"); setInterval(() => {}, 1000);'],
        {
          env: {
            ...process.env,
            HOST_SECRET_ENV_CANARY: hostCanarySecret,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      await new Promise<void>((resolveReady, rejectReady) => {
        hostVictim.once('error', rejectReady);
        hostVictim.stdout.once('data', () => resolveReady());
      });

      try {
        const victimPid = hostVictim.pid;
        assert.equal(typeof victimPid === 'number' && victimPid > 0, true);

        const procProbeBody = `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const targetPid = ${String(victimPid)};
const expectedSecret = ${JSON.stringify(hostCanarySecret)};
let signalAllowed = false;
let signalCode = 'NONE';
try {
  process.kill(targetPid, 0);
  signalAllowed = true;
} catch (err) {
  signalCode = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
}

let leakedEnv = false;
if (process.platform === 'darwin') {
  const pyProbe = [
    'import ctypes, sys',
    'pid = int(sys.argv[1])',
    'secret = sys.argv[2].encode("utf-8")',
    'libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)',
    'mib = (ctypes.c_int * 3)(1, 49, pid)',
    'size = ctypes.c_size_t(0)',
    'rc = libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0)',
    'if rc == 0 and size.value > 0:',
    '    buf = ctypes.create_string_buffer(size.value)',
    '    rc2 = libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0)',
    '    if rc2 == 0 and secret in buf.raw:',
    '        print("PROCARGS2_LEAKED")',
    '        sys.exit(0)',
    'print(f"PROCARGS2_DENIED_ERRNO={ctypes.get_errno()}")',
    'sys.exit(1)',
  ].join('\\n');
  const py = spawnSync('/usr/bin/python3', ['-c', pyProbe, String(targetPid), expectedSecret], { encoding: 'utf8' });
  if ((py.stdout || '').includes('PROCARGS2_LEAKED')) {
    leakedEnv = true;
  } else {
    process.stderr.write('PROC_INSPECT_OUT=' + (py.stdout || '').trim() + '\\n');
  }
} else if (process.platform === 'linux') {
  try {
    const raw = readFileSync('/proc/' + String(targetPid) + '/environ');
    if (raw.includes(Buffer.from(expectedSecret, 'utf8'))) {
      leakedEnv = true;
    }
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
    process.stderr.write('PROC_INSPECT_OUT=' + code + '\\n');
  }
}

process.stderr.write('SIGNAL_ALLOWED=' + String(signalAllowed) + ' SIGNAL_CODE=' + signalCode + ' LEAKED_ENV=' + String(leakedEnv) + '\\n');
if (signalAllowed || leakedEnv) {
  process.exit(0);
}
process.exit(45);
`;

        // Positive uncontained control: inspecting and signaling hostVictim succeeds
        const uncontainedProc = spawnSync(process.execPath, ['--input-type=module', '-e', procProbeBody], {
          encoding: 'utf8',
        });
        assert.equal(uncontainedProc.status, 0, `expected uncontained host-process probe to succeed: ${uncontainedProc.stderr}`);
        assert.equal(uncontainedProc.stderr.includes('SIGNAL_ALLOWED=true'), true);
        assert.equal(uncontainedProc.stderr.includes('LEAKED_ENV=true'), true);

        const { repoRoot: procEscapeRepo } = await createMiniSelfUpgradeRepo(dir, {
          testScriptBody: procProbeBody,
        });
        const stageDir = join(dir, 'stage-proc-isolation');
        await stageAndApplyCandidateUpgrade({
          preflight,
          repoRoot: procEscapeRepo,
          candidateDir: procEscapeRepo,
          stageDir,
        });

        const procEscapeRes = runVerifyScript(procEscapeRepo, {
          SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
          SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
          SELF_UPGRADE_REPO_ROOT: procEscapeRepo,
          SELF_UPGRADE_STAGE_DIR: stageDir,
        });
        assert.notEqual(procEscapeRes.status, 0, 'contained candidate must be denied cross-process inspection and signaling');
        assert.equal(procEscapeRes.stderr.includes('LEAKED_ENV=true'), false);
        assert.equal(procEscapeRes.stderr.includes('SIGNAL_ALLOWED=true'), false);
        assert.match(procEscapeRes.stderr, /SIGNAL_CODE=(EPERM|ESRCH)/);
        assert.equal(hostVictim.exitCode, null, 'host victim process must remain alive');
      } finally {
        hostVictim.kill('SIGKILL');
      }
    });
  });

  it('completes end-to-end loopwright step next + step submit + inspect in no-change and candidate modes while keeping base repo clean', async () => {
    const preflight = await loadPreflightModule();
    const cliMainPath = join(REPO_ROOT, 'packages/cli/dist/main.js');
    const hostNodeModules = join(REPO_ROOT, 'node_modules');

    await withTempDir(async dir => {
      const { repoRoot } = await createMiniSelfUpgradeRepo(dir);
      const runRoot = join(dir, 'runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      // 1) --mode no-change settles no_change via no-change.v1
      const noChangePrep = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir: join(dir, 'stage-no-change'),
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.9.0' : '1.5.0' },
          ]),
        ),
      });
      assert.equal(noChangePrep.recommendedMode, 'no-change');

      const stagedNoChange = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'self-upgrade-no-change-01',
        mode: 'no-change',
        discoverUpstreams: false,
        upstreamRecordsJson: JSON.stringify(noChangePrep.upstreamRecords),
      });
      const loadedNoChange = await loadTrustedConfiguration({
        configPath: stagedNoChange.configPath,
        registryPath: stagedNoChange.registryPath,
        registrySha256: stagedNoChange.registrySha256,
        untrustedRoots: [repoRoot],
      });
      assert.equal(loadedNoChange.ok, true);
      if (!loadedNoChange.ok) return;

      const nextNoChange = await stepNext({
        configuration: loadedNoChange.value,
        repository: repoRoot,
        runRoot,
        runId: 'self-upgrade-no-change-01',
        mode: 'no-change',
      });
      assert.equal(nextNoChange.ok, true);
      if (!nextNoChange.ok || nextNoChange.value.kind !== 'step') {
        assert.fail('expected step yield in no-change mode');
      }

      const submitNoChange = spawnSync(
        process.execPath,
        [
          cliMainPath,
          'step',
          'submit',
          '--run-root',
          runRoot,
          '--run-id',
          'self-upgrade-no-change-01',
          '--lease',
          nextNoChange.value.leaseToken,
          '--status',
          'no_change',
          '--reason',
          'All runtime dependencies match baseline.',
          '--json',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            NODE_BIN_DIR: dirname(process.execPath),
            SELF_UPGRADE_REPO_ROOT: repoRoot,
          },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      assert.equal(submitNoChange.status, 0, `no-change submit failed: ${submitNoChange.stderr}`);
      const parsedNoChange = JSON.parse(submitNoChange.stdout.trim()) as {
        kind: string;
        data?: { result?: { spec?: { status?: string } } };
      };
      assert.equal(parsedNoChange.kind, 'result');
      assert.equal(parsedNoChange.data?.result?.spec?.status, 'no_change');

      // 2) --mode candidate applies staged upgrade INSIDE yielded candidateDir (leaving repoRoot clean!)
      const stageDir = join(dir, 'stage-candidate');
      const candidatePrep = await preflight.runPrepareSelfUpgrade({
        repoRoot,
        stageDir,
        registryFixtures: Object.fromEntries(
          preflight.ALL_UPSTREAM_IDS.map(id => [
            id,
            { version: id === 'yaml' ? '2.10.0' : '1.6.0' },
          ]),
        ),
        lockfileBuilder: async ({ targetVersions }) => Buffer.from(
          buildSyntheticLockfile({
            piVersion: targetVersions.upstreams['pi-coding-agent']!.version,
            yamlVersion: targetVersions.upstreams['yaml']!.version,
            nestedPiTransitiveYamlVersion: '2.9.0',
          }),
          'utf8',
        ),
      });
      assert.equal(candidatePrep.recommendedMode, 'candidate');
      assert.notEqual(candidatePrep.staged, null);

      const stagedCandidate = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'self-upgrade-candidate-01',
        mode: 'candidate',
        discoverUpstreams: false,
        upstreamRecordsJson: JSON.stringify(candidatePrep.upstreamRecords),
      });

      const gateHandle = await openStagedTaskpackStepGate({
        runRoot,
        runId: 'self-upgrade-candidate-01',
      });
      assert.notEqual(gateHandle, null);
      if (gateHandle === null) return;

      let candidateLeaseToken: string;
      let yieldedCandidateDir: string;
      try {
        const prevGateSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loadedCandidate = await loadTrustedConfiguration({
            configPath: stagedCandidate.configPath,
            registryPath: stagedCandidate.registryPath,
            registrySha256: stagedCandidate.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loadedCandidate.ok, true);
          if (!loadedCandidate.ok) return;

          const nextCandidate = await stepNext(
            {
              configuration: loadedCandidate.value,
              repository: repoRoot,
              runRoot,
              runId: 'self-upgrade-candidate-01',
              mode: 'candidate',
              environment: gateHandle.environment,
            },
            { gateUrlOverrides: gateHandle.gateUrlOverrides },
          );
          assert.equal(nextCandidate.ok, true);
          if (!nextCandidate.ok || nextCandidate.value.kind !== 'step') {
            assert.fail('expected step yield in candidate mode');
          }
          candidateLeaseToken = nextCandidate.value.leaseToken;
          yieldedCandidateDir = nextCandidate.value.candidateDir;
        } finally {
          if (prevGateSecret === undefined) {
            delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          } else {
            process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGateSecret;
          }
        }
      } finally {
        await gateHandle.close();
      }

      // Apply staged target-versions.json and package-lock.candidate.json ONLY inside yieldedCandidateDir
      const stagedTargetRaw = await readFile(candidatePrep.staged!.targetVersionsPath, 'utf8');
      const stagedTarget = JSON.parse(stagedTargetRaw) as TargetVersionsPayload;
      const stagedLockRaw = await readFile(candidatePrep.staged!.candidateLockPath);

      await writeFile(join(yieldedCandidateDir, '.loopwright/proposal.json'), stagedTargetRaw, { mode: 0o600 });
      await writeFile(join(yieldedCandidateDir, 'package-lock.json'), stagedLockRaw, { mode: 0o600 });
      for (const [ws, depUpdates] of Object.entries(stagedTarget.packages)) {
        const wsManifestPath = join(yieldedCandidateDir, ws, 'package.json');
        const wsManifest = JSON.parse(await readFile(wsManifestPath, 'utf8')) as {
          dependencies: Record<string, string>;
        };
        wsManifest.dependencies = { ...wsManifest.dependencies, ...depUpdates };
        await writeFile(wsManifestPath, `${JSON.stringify(wsManifest, null, 2)}\n`, { mode: 0o600 });
      }

      const submitCandidate = spawnSync(
        process.execPath,
        [
          cliMainPath,
          'step',
          'submit',
          '--run-root',
          runRoot,
          '--run-id',
          'self-upgrade-candidate-01',
          '--lease',
          candidateLeaseToken,
          '--status',
          'completed',
          '--reason',
          'Upgraded @earendil-works/pi-* to 1.6.0 and yaml to 2.10.0.',
          '--json',
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            GITHUB_ACTIONS: '',
            NODE_BIN_DIR: dirname(process.execPath),
            SELF_UPGRADE_RUN_ROOT: runRoot,
            SELF_UPGRADE_STAGE_DIR: candidatePrep.staged!.stageDir,
            SELF_UPGRADE_NPM_CACHE: candidatePrep.staged!.npmCacheDir,
            SELF_UPGRADE_REPO_ROOT: repoRoot,
            SELF_UPGRADE_ALLOW_TEST_FIXTURE: '1',
            SELF_UPGRADE_TEST_NODE_MODULES: hostNodeModules,
          },
          encoding: 'utf8',
          timeout: 120_000,
        },
      );

      if (!CAN_RUN_KERNEL_CONTAINMENT) {
        // Without kernel containment (e.g. AppArmor-restricted Ubuntu 24.04 CI), command.v1 fails closed:
        // step submit either exits nonzero or yields a repair step / non-completed result instead of 'completed'.
        if (submitCandidate.status === 0) {
          const parsedDenied = JSON.parse(submitCandidate.stdout.trim()) as {
            kind: string;
            data?: { result?: { spec?: { status?: string } } };
          };
          assert.notEqual(parsedDenied.data?.result?.spec?.status, 'completed');
        }
        return;
      }

      assert.equal(
        submitCandidate.status,
        0,
        `candidate submit failed (stdout=${submitCandidate.stdout}, stderr=${submitCandidate.stderr})`,
      );
      const parsedCandidate = JSON.parse(submitCandidate.stdout.trim()) as {
        kind: string;
        data?: { result?: { spec?: { status?: string } } };
      };
      assert.equal(parsedCandidate.kind, 'result');
      assert.equal(parsedCandidate.data?.result?.spec?.status, 'completed');

      // Base repository checkout must remain 100% clean and at baseline 1.5.0 / 2.9.0
      const baseGitStatus = spawnSync(
        'git',
        ['status', '--porcelain', '-z', '--untracked-files=all'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      assert.equal(baseGitStatus.stdout, '');
      const baseProposal = JSON.parse(await readFile(join(repoRoot, '.loopwright/proposal.json'), 'utf8')) as TargetVersionsPayload;
      assert.equal(baseProposal.upstreams['pi-coding-agent']?.version, '1.5.0');
      assert.equal(baseProposal.upstreams['yaml']?.version, '2.9.0');

      // Export inspect bundle and verify captured candidate.files.json contains the upgraded versions
      const inspectDir = join(dir, 'inspect-bundle');
      const inspectRun = spawnSync(
        process.execPath,
        [
          cliMainPath,
          'inspect',
          '--run-root',
          runRoot,
          '--run-id',
          'self-upgrade-candidate-01',
          '--output',
          inspectDir,
          '--json',
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(inspectRun.status, 0, `inspect failed: ${inspectRun.stderr}`);

      const exportedBundle = JSON.parse(await readFile(join(inspectDir, 'candidate.files.json'), 'utf8')) as {
        files: readonly { name: string; encoding: string; body: string }[];
      };
      const decodeExportedJson = (name: string): Record<string, unknown> => {
        const entry = exportedBundle.files.find(f => f.name === name);
        assert.notEqual(entry, undefined, `expected ${name} in candidate.files.json`);
        assert.equal(entry!.encoding, 'base64');
        return JSON.parse(Buffer.from(entry!.body, 'base64').toString('utf8')) as Record<string, unknown>;
      };

      const exportedProposal = decodeExportedJson('.loopwright/proposal.json') as unknown as TargetVersionsPayload;
      assert.equal(exportedProposal.upstreams['pi-coding-agent']?.version, '1.6.0');
      assert.equal(exportedProposal.upstreams['yaml']?.version, '2.10.0');

      const exportedAgentPi = decodeExportedJson('packages/agent-pi/package.json') as {
        dependencies: Record<string, string>;
      };
      assert.equal(exportedAgentPi.dependencies['@earendil-works/pi-coding-agent'], '1.6.0');
      assert.equal(exportedAgentPi.dependencies['@earendil-works/pi-tui'], '1.6.0');

      const exportedCli = decodeExportedJson('packages/cli/package.json') as {
        dependencies: Record<string, string>;
      };
      assert.equal(exportedCli.dependencies['yaml'], '2.10.0');

      const exportedLock = decodeExportedJson('package-lock.json') as {
        packages: Record<string, { version?: string }>;
      };
      assert.equal(exportedLock.packages['node_modules/yaml']?.version, '2.10.0');
      assert.equal(exportedLock.packages['node_modules/@earendil-works/pi-coding-agent']?.version, '1.6.0');
    });
  });

  it('resolves org LLM gateway config into 0o600 models.json and succeeds on dry-run candidate compilation without publicationEndpoint', async () => {
    const preflight = await loadPreflightModule();
    await withTempDir(async dir => {
      const modelsOut = join(dir, 'models.json');

      // 1) Empty env falls back cleanly without writing models.json
      const emptyCfg = await preflight.resolveSelfUpgradeModelConfig({ env: {}, modelsOutPath: modelsOut });
      assert.equal(emptyCfg.configured, false);
      assert.equal(emptyCfg.allowCustomBaseUrl, 'false');

      // 2) Empty-string workflow inputs/vars fall through to org CI_GPUSTACK_CODEREVIEW_LLM_*, strip /chat/completions, and write 0o600 models.json
      const orgCfg = await preflight.resolveSelfUpgradeModelConfig({
        env: {
          SELF_UPGRADE_INPUT_THINKING: '',
          SELF_UPGRADE_INPUT_REASONING_EFFORT: '',
          CI_GPUSTACK_LOOPWRIGHT_LLM_URL: '',
          CI_GPUSTACK_LOOPWRIGHT_LLM_MODEL: '',
          CI_GPUSTACK_LOOPWRIGHT_LLM_THINKING: '',
          CI_GPUSTACK_LOOPWRIGHT_LLM_REASONING_EFFORT: '',
          CI_GPUSTACK_CODEREVIEW_LLM_URL: 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions/',
          CI_GPUSTACK_CODEREVIEW_LLM_MODEL: 'glm-5.3',
          CI_GPUSTACK_CODEREVIEW_LLM_THINKING: 'enabled',
          CI_GPUSTACK_CODEREVIEW_LLM_REASONING_EFFORT: 'medium',
          CI_GPUSTACK_CODEREVIEW_LLM_TEMPERATURE: '0.4',
          CI_GPUSTACK_CODEREVIEW_LLM_TOP_P: '0.9',
        },
        modelsOutPath: modelsOut,
      });
      assert.equal(orgCfg.configured, true);
      assert.equal(orgCfg.modelProvider, 'zai-coding-cn');
      assert.equal(orgCfg.modelId, 'glm-5.3');
      assert.equal(orgCfg.modelThinking, 'high');
      assert.equal(orgCfg.modelApi, 'openai-completions');
      assert.equal(orgCfg.modelBaseUrl, 'https://open.bigmodel.cn/api/coding/paas/v4');
      assert.equal(orgCfg.allowCustomBaseUrl, 'true');
      assert.equal(orgCfg.providerTokenEnv, 'LOOPWRIGHT_SELF_UPGRADE_LLM_TOKEN');

      // Explicit disabled/off thinking stays 'off' with reasoning=false instead of snapping back on
      const disabledThinkingOut = join(dir, 'models-disabled.json');
      const disabledCfg = await preflight.resolveSelfUpgradeModelConfig({
        env: {
          SELF_UPGRADE_INPUT_THINKING: 'disabled',
          CI_GPUSTACK_CODEREVIEW_LLM_URL: 'https://open.bigmodel.cn/api/coding/paas/v4',
          CI_GPUSTACK_CODEREVIEW_LLM_MODEL: 'glm-5.3',
          CI_GPUSTACK_CODEREVIEW_LLM_REASONING_EFFORT: 'medium',
        },
        modelsOutPath: disabledThinkingOut,
      });
      assert.equal(disabledCfg.modelThinking, 'off');
      const parsedDisabledModels = await loadPiModelsJson(disabledThinkingOut);
      assert.equal(parsedDisabledModels.providers.get('zai-coding-cn')?.models.get('glm-5.3')?.reasoning, false);

      const st = await stat(modelsOut);
      assert.equal(st.mode & 0o777, 0o600);
      const parsedModels = await loadPiModelsJson(modelsOut);
      const providerEntry = parsedModels.providers.get('zai-coding-cn');
      assert.equal(providerEntry?.apiKeyEnv, 'LOOPWRIGHT_SELF_UPGRADE_LLM_TOKEN');
      assert.equal(providerEntry?.models.get('glm-5.3')?.contextWindow, 1_000_000);
      assert.equal(providerEntry?.models.get('glm-5.3')?.maxTokens, 65_536);

      // 3) Dedicated CI_GPUSTACK_LOOPWRIGHT_LLM_* takes precedence over CI_GPUSTACK_CODEREVIEW_LLM_*
      const overrideCfg = await preflight.resolveSelfUpgradeModelConfig({
        env: {
          CI_GPUSTACK_LOOPWRIGHT_LLM_URL: 'https://api.openai.com/v1',
          CI_GPUSTACK_LOOPWRIGHT_LLM_MODEL: 'gpt-4.1',
          CI_GPUSTACK_CODEREVIEW_LLM_URL: 'https://open.bigmodel.cn/api/coding/paas/v4',
          CI_GPUSTACK_CODEREVIEW_LLM_MODEL: 'glm-5.3',
        },
      });
      assert.equal(overrideCfg.modelProvider, 'openai');
      assert.equal(overrideCfg.modelId, 'gpt-4.1');

      // 4) Negative cases fail closed
      await assert.rejects(
        () => preflight.resolveSelfUpgradeModelConfig({ env: { CI_GPUSTACK_CODEREVIEW_LLM_URL: 'https://api.openai.com/v1' } }),
        /must be configured together/,
      );
      await assert.rejects(
        () => preflight.resolveSelfUpgradeModelConfig({
          env: {
            CI_GPUSTACK_LOOPWRIGHT_LLM_PROVIDER: 'openai-codex',
            CI_GPUSTACK_CODEREVIEW_LLM_URL: 'https://api.openai.com/v1',
            CI_GPUSTACK_CODEREVIEW_LLM_MODEL: 'gpt-5',
          },
        }),
        /Unsupported LLM provider/,
      );
      await assert.rejects(
        () => preflight.resolveSelfUpgradeModelConfig({
          env: {
            CI_GPUSTACK_CODEREVIEW_LLM_URL: 'http://example.com/v1',
            CI_GPUSTACK_CODEREVIEW_LLM_MODEL: 'glm-5.3',
          },
        }),
        /must use https/,
      );

      // 5) runActionCli with INPUT_DRY-RUN='true' and candidate mode succeeds without INPUT_PUBLICATION-ENDPOINT-URL
      const { repoRoot, headSha } = await createMiniSelfUpgradeRepo(dir);
      const runRoot = join(dir, 'dry-runs');
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      const ghOut = join(dir, 'gh-out.txt');
      const exitCode = await runActionCli({
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKSPACE: repoRoot,
        GITHUB_REPOSITORY: 'gpustack/loopwright',
        GITHUB_SHA: headSha,
        'INPUT_TASKPACK-PATH': '.loopwright/taskpack.yaml',
        'INPUT_MODE': 'candidate',
        'INPUT_EVENT-NAME': 'workflow_dispatch',
        'INPUT_RUN-ROOT': runRoot,
        'INPUT_RUN-ID': 'dry-run-self-upgrade-1',
        'INPUT_DRY-RUN': 'true',
        'INPUT_PROVIDER': orgCfg.modelProvider,
        'INPUT_MODEL': orgCfg.modelId,
        'INPUT_THINKING': orgCfg.modelThinking,
        'INPUT_API': orgCfg.modelApi,
        'INPUT_BASE-URL': orgCfg.modelBaseUrl,
        'INPUT_MODELS-JSON': orgCfg.modelsJsonPath,
        'INPUT_ALLOW-CUSTOM-BASE-URL': orgCfg.allowCustomBaseUrl,
        'INPUT_PROVIDER-TOKEN-ENV': orgCfg.providerTokenEnv,
        'INPUT_UPSTREAM-RECORDS': JSON.stringify(
          preflight.ALL_UPSTREAM_IDS.map(id => ({
            upstreamId: id,
            status: 'available',
            version: id === 'yaml' ? '2.10.0' : '1.6.0',
          })),
        ),
        LOOPWRIGHT_SELF_UPGRADE_LLM_TOKEN: 'sk-org-gateway-token-123456',
        GITHUB_OUTPUT: ghOut,
      });
      assert.equal(exitCode, 0);
      const outRaw = await readFile(ghOut, 'utf8');
      assert.equal(outRaw.includes('sk-org-gateway-token-123456'), false);
      assert.equal(outRaw.includes('"kind":"compiled"'), true);
    });
  });
});
