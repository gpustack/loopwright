import assert from 'node:assert/strict';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { validateDocument } from '@loopwright/core';
import { compilePlan, loadTrustedConfiguration } from '@loopwright/controller';
import { compileDeclarativeTaskpack, authorizeRepositoryActor, boundDiagnosticLog, DEFAULT_HOST_BUDGETS, loadDeclarativeTaskpack, parseActionsRunUrl, parseCommentCommand, prepareTaskpackIntake, validateCommentGuidance } from '../src/taskpack.js';
import { parseTaskpackDocument, validateTaskpackManifest, type Json } from '../src/schema.js';
import { GITHUB_APP_CONFIG_API_VERSION, loadGitHubAppConfig, parseGitHubAppConfigDocument, startConfiguredGitHubApp } from '../src/config.js';
import { resolveTaskpackModelCandidates, selectHealthyModelCandidate } from '../src/models-config.js';
import { createGitHubRestTokenTransport, InstallationTokenBroker, SecretScrubber } from '../src/token-broker.js';
import { serializePrettyYaml } from '../src/yaml.js';
import { GitHubAppError, type HostTaskpackBindings, type TaskpackManifest } from '../src/types.js';

const VALID_MANIFEST_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
spec:
  goal:
    candidate: Refresh documentation from upstream sources and pass every local check.
    noChange: Confirm the documentation needs no change and settle as no change.
  scope:
    writable:
      - docs
    protected:
      - docs/protected-notes.md
  upstreams:
    - id: engine
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: docs-proposal-json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-docs-
    titleTemplate: 'docs: sync upstream documentation'
  memory:
    directory: .loopwright/memory/docs-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
`;

const TENANT = { installationId: 1, repositoryId: 2, repositoryFullName: 'octocat/target', taskpackId: 'docs-sync' };

function bindingsFor(manifest: TaskpackManifest, overrides: Partial<HostTaskpackBindings> = {}): HostTaskpackBindings {
  void manifest;
  return {
    mode: 'candidate',
    repository: 'octocat/target',
    baseRevision: 'b'.repeat(40),
    sourceRevision: 'a'.repeat(40),
    roleSelection: { provider: 'zai', model: 'glm-5.3', thinking: 'high' },
    budgets: DEFAULT_HOST_BUDGETS,
    publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
    credentialEnvMap: { provider: 'TASKPACK_TEST_PROVIDER_TOKEN', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
    ...overrides,
  };
}

function editedManifest(manifest: TaskpackManifest, mutate: (draft: Record<string, unknown>) => void): Json {
  const draft = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  mutate(draft);
  return draft as unknown as Json;
}

async function withSandbox(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-taskpack-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

/** Write compiled artifacts into separate trusted (owner-only, symlink-free) temporary directories; the
 * controller loader refuses a registry living inside the configuration directory's trust roots. */
async function writeTrustedArtifacts(registryBytes: Buffer, configBytes: Buffer): Promise<{ registryPath: string; configPath: string }> {
  const registryDirectory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-registry-'));
  const configDirectory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-config-'));
  const registryPath = join(registryDirectory, 'registry.yaml');
  const configPath = join(configDirectory, 'config.yaml');
  await writeFile(registryPath, registryBytes);
  await writeFile(configPath, configBytes);
  await chmod(registryPath, 0o600);
  await chmod(configPath, 0o600);
  await chmod(registryDirectory, 0o700);
  await chmod(configDirectory, 0o700);
  return { registryPath, configPath };
}

const savedEnv: Record<string, string | undefined> = {};
after(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function withEnv(name: string, value: string): void {
  savedEnv[name] ??= process.env[name];
  process.env[name] = value;
}

describe('declarative taskpack loading (AC-1)', () => {
  it('loads a valid .loopwright/taskpack.yaml and defaults commentPrefixes', async () => {
    await withSandbox(async root => {
      const manifestPath = join(root, 'taskpack.yaml');
      await writeFile(manifestPath, VALID_MANIFEST_YAML);
      const manifest = await loadDeclarativeTaskpack({ manifestPath });
      assert.equal(manifest.metadata.name, 'docs-sync');
      assert.deepEqual(manifest.spec.triggers.commentPrefixes, ['/loopwright']);
      assert.deepEqual(manifest.spec.scope.protected, ['docs/protected-notes.md']);
    });
  });

  it('loads the same manifest written as .yml and as strict JSON', async () => {
    const yamlManifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    const asJson = JSON.stringify(yamlManifest);
    const jsonManifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(asJson, 'utf8'), format: 'json' });
    assert.deepEqual(jsonManifest, yamlManifest);
  });

  it('refuses manifests over 65536 bytes', async () => {
    const padded = `${VALID_MANIFEST_YAML}\n# ${'x'.repeat(70_000)}\n`;
    assert.throws(() => parseTaskpackDocument(Buffer.from(padded, 'utf8'), 'yaml'), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
  });

  it('refuses a symlinked manifest file', async () => {
    await withSandbox(async root => {
      const real = join(root, 'taskpack.yaml');
      await writeFile(real, VALID_MANIFEST_YAML);
      const link = join(root, 'link.yaml');
      await symlink(real, link);
      await assert.rejects(loadDeclarativeTaskpack({ manifestPath: link }), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
    });
  });

  it('refuses .. traversal in the manifest path', async () => {
    await withSandbox(async root => {
      await mkdir(join(root, '.loopwright'));
      await assert.rejects(loadDeclarativeTaskpack({ manifestPath: join('.loopwright', '..', 'taskpack.yaml'), repositoryRoot: root }),
        (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
    });
  });

  it('refuses ${...} interpolation in YAML and JSON manifests', () => {
    assert.throws(() => parseTaskpackDocument(Buffer.from(`${VALID_MANIFEST_YAML}\n# \${SECRET}\n`, 'utf8'), 'yaml'),
      (error: GitHubAppError) => error.code === 'TASKPACK_UNTRUSTED_INTERPOLATION');
    assert.throws(() => parseTaskpackDocument(Buffer.from('{"apiVersion":"loopwright.dev/v1alpha1","note":"${SECRET}"}', 'utf8'), 'json'),
      (error: GitHubAppError) => error.code === 'TASKPACK_UNTRUSTED_INTERPOLATION');
  });

  it('refuses prototype-pollution keys in YAML and JSON manifests', () => {
    assert.throws(() => parseTaskpackDocument(Buffer.from('__proto__: polluted\n', 'utf8'), 'yaml'),
      (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
    assert.throws(() => parseTaskpackDocument(Buffer.from('{"constructor": {"prototype": {}}}', 'utf8'), 'json'),
      (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
    assert.throws(() => parseTaskpackDocument(Buffer.from('{"a": 1, "a": 2}', 'utf8'), 'json'),
      (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
  });

  it('enforces metadata.name, goal bounds, and upstream count limits', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.metadata as Record<string, unknown>).name = 'Docs-Sync';
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).goal = { candidate: 'x'.repeat(1025), noChange: 'fine' };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).upstreams = [];
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
  });

  it('rejects writable paths that overlap the effective protected set with TASKPACK_SCOPE_VIOLATION', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).scope = { writable: ['docs', '.github'], protected: [] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
  });

  it('requires the proposal path to live inside the writable scope', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).proposal = { path: 'outside/proposal.json', requiredFields: ['schema_version'], schemaVersion: 1 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
  });

  it('rejects writable entries that encompass a built-in protected path', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).scope = { writable: ['.loopwright'], protected: [] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).scope = { writable: ['.github/workflows', 'docs'], protected: [] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
  });

  it('rejects proposal paths that overlap protected paths with TASKPACK_SCOPE_VIOLATION', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    // proposal.path nested inside a manifest-declared protected path
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).proposal = { path: 'docs/protected-notes.md', requiredFields: ['schema_version'], schemaVersion: 1 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
    // proposal.path covering a protected path as a parent directory
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).scope = { writable: ['docs'], protected: ['docs/proposals'] };
      (draft.spec as Record<string, unknown>).proposal = { path: 'docs/proposals', requiredFields: ['schema_version'], schemaVersion: 1 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
  });

  it('pins the memory directory under .loopwright/memory/<id> and disjoint from writable scope', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).memory = { directory: 'memory', apply: 'separate-pull-request', onNoModelBudget: 'deterministic-observations-only' };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_SCOPE_VIOLATION');
  });

  it('validates optional spec.sandbox declarations and rejects invalid backends, capabilities, or traversal paths (AC-3)', async () => {
    const withSandboxYaml = `${VALID_MANIFEST_YAML}  sandbox:
    preferredBackends:
      - macos-seatbelt
      - linux-bwrap
      - linux-landlock
      - docker
    networkMode: loopback-only
    requiredCapabilities:
      - filesystemReadContainment
      - filesystemWriteContainment
      - protectedPathReadOnlyMask
    deniedReadPaths:
      - ~/.ssh
      - secrets/local
`;
    const parsed = await loadDeclarativeTaskpack({ bytes: Buffer.from(withSandboxYaml, 'utf8'), format: 'yaml' });
    assert.deepEqual(parsed.spec.sandbox, {
      preferredBackends: ['macos-seatbelt', 'linux-bwrap', 'linux-landlock', 'docker'],
      networkMode: 'loopback-only',
      requiredCapabilities: ['filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask'],
      deniedReadPaths: ['~/.ssh', 'secrets/local'],
    });

    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).sandbox = { preferredBackends: ['unknown-backend'] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).sandbox = { preferredBackends: ['macos-seatbelt', 'macos-seatbelt'] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).sandbox = { requiredCapabilities: ['invalidCapability'] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.spec as Record<string, unknown>).sandbox = { deniedReadPaths: ['~/.ssh/../etc/passwd'] };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
  });
});

describe('compileDeclarativeTaskpack (AC-1)', () => {
  it('emits registry and config documents that pass validateDocument, loadTrustedConfiguration, and compilePlan', async () => {
    await withSandbox(async root => {
      withEnv('TASKPACK_TEST_PROVIDER_TOKEN', 'provider-token-value');
      withEnv('TASKPACK_TEST_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
      const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
      const compiled = await compileDeclarativeTaskpack(manifest, bindingsFor(manifest));
      const validated = validateDocument(compiled.config.spec.task, 'TaskContract');
      assert.equal(validated.ok, true);
      assert.equal(compiled.registrySha256, createHash('sha256').update(compiled.registryBytes).digest('hex'));
      const registryYamlText = compiled.registryBytes.toString('utf8');
      assert.match(registryYamlText, /^apiVersion: loopwright\.dev\/v1alpha1\nkind: TrustedRegistry\n/);
      const { registryPath, configPath } = await writeTrustedArtifacts(compiled.registryBytes, Buffer.from(serializePrettyYaml(compiled.config), 'utf8'));
      const loaded = await loadTrustedConfiguration({ configPath, registryPath, registrySha256: compiled.registrySha256, untrustedRoots: [root] });
      assert.equal(loaded.ok, true, `loadTrustedConfiguration failed: ${loaded.ok ? '' : loaded.error.code}`);
      if (loaded.ok) {
        const plan = await compilePlan(loaded.value);
        assert.equal(plan.ok, true, `compilePlan failed: ${plan.ok ? '' : plan.error.code}`);
      }
    });
  });

  it('compiles no-change mode without publication bindings', async () => {
    const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    const compiled = await compileDeclarativeTaskpack(manifest, bindingsFor(manifest, { mode: 'no-change', publicationEndpoint: null, credentialEnvMap: { provider: 'TASKPACK_TEST_PROVIDER_TOKEN' } }));
    assert.equal(compiled.config.spec.publication.mode, 'disabled');
    assert.equal(compiled.config.spec.task.spec.goal.startsWith('Confirm the documentation'), true);
    const validated = validateDocument(compiled.config.spec.task, 'TaskContract');
    assert.equal(validated.ok, true);
  });

  it('refuses candidate publication when the host binding omits a publication endpoint', async () => {
    const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    await assert.rejects(
      compileDeclarativeTaskpack(manifest, bindingsFor(manifest, { publicationEndpoint: null })),
      (error: GitHubAppError) => error.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
  });

  it('rejects an external gate whose endpoint binding is missing', async () => {
    const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    const withGate = editedManifest(manifest, draft => {
      (draft.spec as Record<string, unknown>).verification = {
        localChecks: [],
        externalGates: [{ id: 'docs-gate', gateId: 'candidate-validation', endpointId: 'missing-endpoint', required: true }],
      };
    });
    await assert.rejects(
      compileDeclarativeTaskpack(validateTaskpackManifest(withGate) , bindingsFor(manifest, {
        gateEndpoints: [{ id: 'other-endpoint', url: 'https://gate.example.test', signingCredentialRef: 'gate-signing' }],
        credentialEnvMap: { provider: 'TASKPACK_TEST_PROVIDER_TOKEN', gate: 'TASKPACK_TEST_GATE_SIGNING_SECRET', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
      })),
      (error: GitHubAppError) => error.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
  });

  it('compiles a manifest with an external gate and scrubs compiled artifacts', async () => {
    await withSandbox(async root => {
      withEnv('TASKPACK_TEST_PROVIDER_TOKEN', 'provider-token-value');
      withEnv('TASKPACK_TEST_GATE_SIGNING_SECRET', 'gate-signing-value');
      withEnv('TASKPACK_TEST_PUBLICATION_SIGNING_SECRET', 'publication-signing-value');
      const manifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
      const withGate = editedManifest(manifest, draft => {
        (draft.spec as Record<string, unknown>).verification = {
          localChecks: [{ id: 'docs-proposal-json', implementation: 'json-artifact.v1' }],
          externalGates: [{ id: 'docs-gate', gateId: 'candidate-validation', endpointId: 'docs-gate', required: true }],
        };
      });
      const compiled = await compileDeclarativeTaskpack(validateTaskpackManifest(withGate), bindingsFor(manifest, {
        gateEndpoints: [{ id: 'docs-gate', url: 'https://gate.example.test/verify', signingCredentialRef: 'docs-gate-signing' }],
        credentialEnvMap: {
          provider: 'TASKPACK_TEST_PROVIDER_TOKEN', gate: 'TASKPACK_TEST_GATE_SIGNING_SECRET',
          publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET',
        },
      }));
      const { registryPath, configPath } = await writeTrustedArtifacts(compiled.registryBytes, Buffer.from(serializePrettyYaml(compiled.config), 'utf8'));
      const loaded = await loadTrustedConfiguration({ configPath, registryPath, registrySha256: compiled.registrySha256, untrustedRoots: [root] });
      assert.equal(loaded.ok, true, `loadTrustedConfiguration failed: ${loaded.ok ? '' : loaded.error.code}`);
    });
  });
});

describe('generic intake helpers (AC-1)', () => {
  it('evaluates discover intake into ready, no_change, and blocked dispositions', () => {
    const ready = prepareTaskpackIntake({
      mode: 'discover', tenant: TENANT, baseRevision: 'b'.repeat(40),
      records: [
        { upstreamId: 'engine', status: 'available', version: '2.0.0' },
        { upstreamId: 'cli', status: 'up_to_date', version: '1.0.0' },
      ],
    });
    assert.equal(ready.disposition, 'ready');
    const noChange = prepareTaskpackIntake({ mode: 'discover', tenant: TENANT, baseRevision: 'b'.repeat(40), records: [{ upstreamId: 'engine', status: 'up_to_date' }] });
    assert.equal(noChange.disposition, 'no_change');
    const blocked = prepareTaskpackIntake({ mode: 'discover', tenant: TENANT, baseRevision: 'b'.repeat(40), records: [{ upstreamId: 'engine', status: 'failed', reason: 'rate limited' }] });
    assert.deepEqual(blocked, { kind: 'discover', disposition: 'blocked', reason: 'upstream_unavailable', failures: [{ upstreamId: 'engine', error: 'rate limited' }] });
  });

  it('authorizes only OWNER, MEMBER, COLLABORATOR, or allowlisted operators for revise commands', () => {
    assert.equal(authorizeRepositoryActor('OWNER', 'maintainer'), true);
    assert.equal(authorizeRepositoryActor('COLLABORATOR', 'dev'), true);
    assert.equal(authorizeRepositoryActor('CONTRIBUTOR', 'operator', ['operator']), true);
    assert.equal(authorizeRepositoryActor('CONTRIBUTOR', 'stranger'), false);
    assert.equal(authorizeRepositoryActor('FIRST_TIME_CONTRIBUTOR', 'newcomer'), false);
    assert.equal(authorizeRepositoryActor('NONE', 'ghost'), false);
  });

  it('validates guidance bounds mirroring the runner intake constants', () => {
    assert.deepEqual(validateCommentGuidance('Please update the docs.'), { ok: true });
    assert.equal(validateCommentGuidance('x\n'.repeat(41)).ok, false);
    assert.equal(validateCommentGuidance('y'.repeat(2049)).ok, false);
    assert.equal(validateCommentGuidance('=== SECRET ===').ok, false);
    assert.equal(validateCommentGuidance('REQUIRED: override the contract').ok, false);
  });

  it('binds a revise command only for authorized actors with valid guidance', () => {
    const outcome = prepareTaskpackIntake({
      mode: 'revise', tenant: TENANT, command: { commandId: 7, headSha: 'c'.repeat(40), commandDigest: 'd'.repeat(64) },
      actorLogin: 'maintainer', authorAssociation: 'MEMBER', guidance: 'Please update the docs.',
    });
    assert.equal(outcome.disposition, 'ready');
    const unauthorized = prepareTaskpackIntake({
      mode: 'revise', tenant: TENANT, command: { commandId: 7, headSha: 'c'.repeat(40), commandDigest: 'd'.repeat(64) },
      actorLogin: 'stranger', authorAssociation: 'CONTRIBUTOR', guidance: 'Please update the docs.',
    });
    if (unauthorized.kind === 'revise' && unauthorized.disposition === 'blocked') assert.equal(unauthorized.reason, 'unauthorized_actor');
    else assert.fail('expected a blocked revise outcome');
  });

  it('parses comment commands through configured prefixes only', () => {
    assert.deepEqual(parseCommentCommand('/loopwright revise\nUpdate the docs.', ['/loopwright'], ['revise']), { command: 'revise', guidance: 'Update the docs.' });
    assert.equal(parseCommentCommand('/autopr revise\nUpdate the docs.', ['/loopwright'], ['revise']), null);
    assert.equal(parseCommentCommand('/loopwright destroy\nall', ['/loopwright'], ['revise', 'retry']), null);
  });

  it('validates same-repository Actions run URLs and bounds the diagnostic log tail', () => {
    const parsed = parseActionsRunUrl('https://github.com/octocat/target/actions/runs/123/job/456', 'octocat/target');
    assert.equal(parsed.ok, true);
    const cross = parseActionsRunUrl('https://github.com/other/repo/actions/runs/123', 'octocat/target');
    assert.equal(cross.ok, false);
    assert.equal(cross.ok ? '' : cross.reason, 'unknown_repository_url');
    const malformed = parseActionsRunUrl('https://example.test/not-a-run', 'octocat/target');
    assert.equal(malformed.ok ? '' : malformed.reason, 'invalid_run_url');
    const bounded = boundDiagnosticLog(`${'a'.repeat(5000)} === sentinel ===`);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.jobLogText.includes('=== sentinel ==='), false);
    assert.ok(bounded.jobLogText.length <= 4000);
  });

  it('returns a ready status disposition for status queries', () => {
    const outcome = prepareTaskpackIntake({ mode: 'status', tenant: TENANT });
    assert.deepEqual(outcome, { kind: 'status', disposition: 'ready', summary: 'status query admitted for octocat/target/docs-sync' });
  });

  it('loads a manifest through a repository-rooted file path', async () => {
    await withSandbox(async root => {
      const manifestPath = join(root, 'taskpack.yaml');
      await writeFile(manifestPath, VALID_MANIFEST_YAML);
      const loaded = await loadDeclarativeTaskpack({ manifestPath, repositoryRoot: root });
      assert.equal(loaded.metadata.name, 'docs-sync');
    });
  });

  it('validates optional spec.decisions and .yaml/.yml/.json proposal paths (AC-4)', async () => {
    const withDecisionsYaml = `${VALID_MANIFEST_YAML}  decisions:
    enabled: true
    provider: typesafe-jev
    disclosurePolicy: repo-approved-redacted-evidence
    minConfidence: 0.85
    confirmThreshold: 0.65
    hardDeadlineMs: 4000
    maxAttempts: 2
    allowImages: false
`;
    const parsed = await loadDeclarativeTaskpack({ bytes: Buffer.from(withDecisionsYaml, 'utf8'), format: 'yaml' });
    assert.deepEqual(parsed.spec.decisions, {
      enabled: true,
      provider: 'typesafe-jev',
      disclosurePolicy: 'repo-approved-redacted-evidence',
      minConfidence: 0.85,
      confirmThreshold: 0.65,
      hardDeadlineMs: 4000,
      maxAttempts: 2,
      allowImages: false,
    });

    // Verify .yaml and .yml proposal paths inside writable scope
    for (const ext of ['proposal.yaml', 'proposal.yml', 'proposal.json']) {
      const manifestWithExt = validateTaskpackManifest(editedManifest(parsed, draft => {
        (draft.spec as Record<string, unknown>).proposal = { path: `docs/${ext}`, requiredFields: ['schema_version'], schemaVersion: 1 };
      }));
      assert.equal(manifestWithExt.spec.proposal.path, `docs/${ext}`);
    }

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).proposal = { path: 'docs/proposal.txt', requiredFields: ['schema_version'], schemaVersion: 1 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    // Reject unknown keys, out-of-range numbers, confirmThreshold > minConfidence, invalid enums
    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, unknownKey: 1 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, minConfidence: 0.4 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, minConfidence: 0.7, confirmThreshold: 0.8 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    // Default confirmThreshold (0.6) must not exceed explicit minConfidence (0.5)
    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, minConfidence: 0.5 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID' && error.message.includes('confirmThreshold must not exceed minConfidence'));

    // Provider and disclosurePolicy enum sets match @loopwright/decisions
    const expectedProviders = [
      'typesafe-jev', 'openai-decisions', 'startlux-decision', 'microsoft-decision',
      'perplexity-decider', 'cloudflare-clef', 'liquid-d1',
    ] as const;
    for (const provider of expectedProviders) {
      const m = validateTaskpackManifest(editedManifest(parsed, draft => {
        (draft.spec as Record<string, unknown>).decisions = { enabled: true, provider };
      }));
      assert.equal(m.spec.decisions?.provider, provider);
    }
    const expectedDisclosures = [
      'disabled', 'repo-approved-redacted-evidence', 'public-metadata-only',
    ] as const;
    for (const disclosurePolicy of expectedDisclosures) {
      const m = validateTaskpackManifest(editedManifest(parsed, draft => {
        (draft.spec as Record<string, unknown>).decisions = { enabled: true, disclosurePolicy };
      }));
      assert.equal(m.spec.decisions?.disclosurePolicy, disclosurePolicy);
    }

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, provider: 'invalid-provider' };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, disclosurePolicy: 'invalid-policy' };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, hardDeadlineMs: 50 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');

    assert.throws(() => validateTaskpackManifest(editedManifest(parsed, draft => {
      (draft.spec as Record<string, unknown>).decisions = { enabled: true, maxAttempts: 3 };
    })), (error: GitHubAppError) => error.code === 'TASKPACK_MANIFEST_INVALID');
  });

  it('validates and loads github-app.yaml via parseGitHubAppConfigDocument and loadGitHubAppConfig (AC-4)', async () => {
    const validAppConfigYaml = `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  apiBaseUrl: https://api.github.com
  listen:
    host: 127.0.0.1
    port: 8080
    webhookPath: /webhooks/github
  tokenTtlSeconds: 600
  maxPayloadBytes: 1048576
  taskpackPath: .loopwright/taskpack.yaml
`;
    const doc = parseGitHubAppConfigDocument(Buffer.from(validAppConfigYaml, 'utf8'), 'yaml');
    assert.equal(doc.kind, 'GitHubAppConfig');
    assert.equal(doc.spec.appId, '123456');
    assert.equal(doc.spec.listen?.port, 8080);

    const fromJson = parseGitHubAppConfigDocument(Buffer.from(JSON.stringify(doc), 'utf8'), 'json');
    assert.deepEqual(fromJson, doc);

    await withSandbox(async root => {
      const yamlPath = join(root, 'github-app.yaml');
      await writeFile(yamlPath, validAppConfigYaml, { mode: 0o600 });
      const loadedWithoutEnv = await loadGitHubAppConfig(yamlPath);
      assert.deepEqual(loadedWithoutEnv.document, doc);
      assert.equal(loadedWithoutEnv.webhookSecret, undefined);

      const loadedWithEnv = await loadGitHubAppConfig(yamlPath, {
        env: { GITHUB_WEBHOOK_SECRET: 'whsec_test', GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----' },
      });
      assert.equal(loadedWithEnv.webhookSecret, 'whsec_test');
      assert.equal(loadedWithEnv.privateKeyPem, '-----BEGIN RSA PRIVATE KEY-----');

      // Missing env secret fails closed with GITHUB_APP_CONFIG_INVALID
      await assert.rejects(
        loadGitHubAppConfig(yamlPath, { env: { GITHUB_WEBHOOK_SECRET: 'whsec_test' } }),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID',
      );

      // Symlink refusal
      const linkPath = join(root, 'linked-app.yaml');
      await symlink(yamlPath, linkPath);
      await assert.rejects(
        loadGitHubAppConfig(linkPath),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID',
      );

      // Duplicate keys refusal
      const dupYaml = `${validAppConfigYaml}  appId: '999'\n`;
      assert.throws(
        () => parseGitHubAppConfigDocument(Buffer.from(dupYaml, 'utf8'), 'yaml'),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID',
      );
    });
  });

  it('enforces opt-in spec.listen.enabled in startConfiguredGitHubApp and mints installation tokens via createGitHubRestTokenTransport (AC-4)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await withSandbox(async root => {
      const noListenPath = join(root, 'no-listen.yaml');
      await writeFile(noListenPath, `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
`, { mode: 0o600 });

      await assert.rejects(
        startConfiguredGitHubApp(noListenPath, {
          env: { GITHUB_WEBHOOK_SECRET: 'whsec_test', GITHUB_APP_PRIVATE_KEY: privateKeyPem },
          repoRoot: root,
        }),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID' && error.path === '/spec/listen/enabled',
      );

      const disabledListenPath = join(root, 'disabled-listen.yaml');
      await writeFile(disabledListenPath, `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  listen:
    enabled: false
    host: 127.0.0.1
    port: 0
`, { mode: 0o600 });

      await assert.rejects(
        startConfiguredGitHubApp(disabledListenPath, {
          env: { GITHUB_WEBHOOK_SECRET: 'whsec_test', GITHUB_APP_PRIVATE_KEY: privateKeyPem },
          repoRoot: root,
        }),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID' && error.path === '/spec/listen/enabled',
      );

      const enabledListenPath = join(root, 'enabled-listen.yaml');
      await mkdir(join(root, '.loopwright'), { recursive: true });
      await writeFile(join(root, '.loopwright', 'taskpack.yaml'), VALID_MANIFEST_YAML, { mode: 0o600 });
      await writeFile(enabledListenPath, `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  apiBaseUrl: https://api.github.com/
  listen:
    enabled: true
    host: 127.0.0.1
    port: 0
    webhookPath: /hooks/gh
  tokenTtlSeconds: 600
  maxPayloadBytes: 65536
  taskpackPath: .loopwright/taskpack.yaml
`, { mode: 0o600 });

      const handle = await startConfiguredGitHubApp(enabledListenPath, {
        env: { GITHUB_WEBHOOK_SECRET: 'whsec_test', GITHUB_APP_PRIVATE_KEY: privateKeyPem },
        repoRoot: root,
      });
      try {
        assert.equal(handle.host, '127.0.0.1');
        assert.ok(handle.port > 0);
        assert.equal(handle.webhookPath, '/hooks/gh');
        const healthRes = await fetch(`${handle.url}/healthz`);
        assert.equal(healthRes.status, 200);
        const healthJson = await healthRes.json() as { ok?: boolean };
        assert.equal(healthJson.ok, true);
      } finally {
        await handle.close();
      }

      let seenUrl = '';
      let seenAuthHeader = '';
      let seenBody = '';
      const expiresIso = new Date(1_700_000_600_000).toISOString();
      const transport = createGitHubRestTokenTransport({
        appId: 123456,
        privateKeyPem,
        apiBaseUrl: 'https://api.github.com/',
        nowSeconds: () => 1_700_000_000,
        fetchImpl: async (input, init) => {
          seenUrl = String(input);
          const headers = init?.headers as Record<string, string> | undefined;
          seenAuthHeader = headers?.['Authorization'] ?? '';
          seenBody = String(init?.body ?? '');
          return new Response(JSON.stringify({
            token: 'ghs_rest_minted_token_0123456789abcdef',
            expires_at: expiresIso,
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        },
      });

      const minted = await transport.createInstallationToken({
        installationId: 77,
        repositoryIds: [99],
        permissions: { contents: 'read', metadata: 'read' },
      });
      assert.equal(seenUrl, 'https://api.github.com/app/installations/77/access_tokens');
      assert.match(seenAuthHeader, /^Bearer /);
      const jwt = seenAuthHeader.slice('Bearer '.length);
      const [headerB64, payloadB64, sigB64] = jwt.split('.');
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${headerB64}.${payloadB64}`);
      assert.equal(verifier.verify(publicKeyPem, Buffer.from(sigB64!, 'base64url')), true);
      assert.deepEqual(JSON.parse(seenBody), {
        repository_ids: [99],
        permissions: { contents: 'read', metadata: 'read' },
      });
      assert.equal(minted.token, 'ghs_rest_minted_token_0123456789abcdef');
      assert.equal(minted.expiresAtMs, Date.parse(expiresIso));

      // Non-loopback HTTP apiBaseUrl is rejected in parseGitHubAppConfigDocument and createGitHubRestTokenTransport,
      // while loopback HTTP (127.0.0.1 / localhost) and HTTPS pass.
      const makeConfigWithApiUrl = (apiBaseUrl: string) => `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  apiBaseUrl: ${apiBaseUrl}
`;
      assert.throws(
        () => parseGitHubAppConfigDocument(Buffer.from(makeConfigWithApiUrl('http://api.example.com'), 'utf8'), 'yaml'),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID' && error.path === '/spec/apiBaseUrl',
      );
      assert.throws(
        () => createGitHubRestTokenTransport({ appId: 123456, privateKeyPem, apiBaseUrl: 'http://api.example.com' }),
        (error: GitHubAppError) => error.code === 'TOKEN_BROKER_CONFIG_INVALID',
      );
      assert.equal(
        parseGitHubAppConfigDocument(Buffer.from(makeConfigWithApiUrl('http://127.0.0.1:9999'), 'utf8'), 'yaml').spec.apiBaseUrl,
        'http://127.0.0.1:9999',
      );
      assert.equal(
        parseGitHubAppConfigDocument(Buffer.from(makeConfigWithApiUrl('https://api.github.com'), 'utf8'), 'yaml').spec.apiBaseUrl,
        'https://api.github.com',
      );

      // Reserved webhookPath routes (/healthz and /tenants/*) are rejected
      for (const reservedPath of ['/healthz', '/tenants/1/2/docs-sync/lease']) {
        assert.throws(
          () => parseGitHubAppConfigDocument(Buffer.from(`apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  listen:
    host: 127.0.0.1
    port: 0
    webhookPath: ${reservedPath}
`, 'utf8'), 'yaml'),
          (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID' && error.path === '/spec/listen/webhookPath',
        );
      }

      // Missing spec.taskpackPath fails closed in startConfiguredGitHubApp with GITHUB_APP_CONFIG_INVALID
      const missingTaskpackConfigPath = join(root, 'missing-taskpack.yaml');
      await writeFile(missingTaskpackConfigPath, `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  listen:
    enabled: true
    host: 127.0.0.1
    port: 0
  taskpackPath: .loopwright/does-not-exist.yaml
`, { mode: 0o600 });
      await assert.rejects(
        startConfiguredGitHubApp(missingTaskpackConfigPath, {
          env: { GITHUB_WEBHOOK_SECRET: 'whsec_test', GITHUB_APP_PRIVATE_KEY: privateKeyPem },
          repoRoot: root,
        }),
        (error: GitHubAppError) => error.code === 'GITHUB_APP_CONFIG_INVALID' && error.path === '/spec/taskpackPath',
      );

      // spec.operatorAllowlist and tokenTtlSeconds cap work in startConfiguredGitHubApp & InstallationTokenBroker
      const cappedBroker = new InstallationTokenBroker({
        appId: 123456,
        privateKeyPem,
        maxTtlMs: 60_000,
        refreshMarginMs: 10_000,
        nowSeconds: () => 1_700_000_000,
        transport: {
          createInstallationToken: async () => ({
            token: 'ghs_uncapped_upstream_token_0123456789abcdef',
            expiresAtMs: 1_700_003_600_000, // 3600s upstream
          }),
        },
      });
      const cappedGrant = await cappedBroker.mint(TENANT, 'read_only');
      assert.equal(cappedGrant.expiresAtMs, 1_700_000_060_000);

      const allowlistConfigPath = join(root, 'allowlist-app.yaml');
      await writeFile(allowlistConfigPath, `apiVersion: ${GITHUB_APP_CONFIG_API_VERSION}
kind: GitHubAppConfig
spec:
  appId: '123456'
  webhookSecretEnv: GITHUB_WEBHOOK_SECRET
  privateKeyEnv: GITHUB_APP_PRIVATE_KEY
  listen:
    enabled: true
    host: 127.0.0.1
    port: 0
  tokenTtlSeconds: 120
  taskpackPath: .loopwright/taskpack.yaml
  operatorAllowlist:
    - trusted-operator
`, { mode: 0o600 });
      const parsedAllowlistDoc = parseGitHubAppConfigDocument(await readFile(allowlistConfigPath), 'yaml');
      assert.deepEqual(parsedAllowlistDoc.spec.operatorAllowlist, ['trusted-operator']);
      const allowlistHandle = await startConfiguredGitHubApp(allowlistConfigPath, {
        env: { GITHUB_WEBHOOK_SECRET: 'whsec_test', GITHUB_APP_PRIVATE_KEY: privateKeyPem },
        repoRoot: root,
      });
      await allowlistHandle.close();
    });
  });

  it('verifies examples/task.yaml parses to the exact same TaskContract as examples/task.json (AC-4)', async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const jsonBytes = await readFile(join(repoRoot, 'examples', 'task.json'));
    const yamlBytes = await readFile(join(repoRoot, 'examples', 'task.yaml'));
    const parsedJson = parseTaskpackDocument(jsonBytes, 'json');
    const parsedYaml = parseTaskpackDocument(yamlBytes, 'yaml');
    assert.deepEqual(parsedYaml, parsedJson);
    const validatedYaml = validateDocument(parsedYaml, 'TaskContract');
    const validatedJson = validateDocument(parsedJson, 'TaskContract');
    assert.equal(validatedYaml.ok, true);
    assert.equal(validatedJson.ok, true);
    if (validatedYaml.ok && validatedJson.ok) {
      assert.deepEqual(validatedYaml.value, validatedJson.value);
    }
  });

  it('compiles built-in token Pi providers (zai/glm-5.3, anthropic, openai), custom compatible gateways, and ordered spec.models fallbacks', async () => {
    withEnv('ZAI_API_KEY', 'zai_token_test_123456');
    withEnv('ZAI_BACKUP_API_KEY', 'zai_backup_token_test_789012');
    withEnv('TASKPACK_TEST_PUBLICATION_SIGNING_SECRET', 'pub_secret_test_123456');
    const zaiYaml = `${VALID_MANIFEST_YAML}  models:
    - provider: zai
      id: glm-5.3
      thinking: high
      apiKeyEnv: ZAI_API_KEY
    - provider: zai-coding-cn
      id: glm-5.3
      thinking: high
      apiKeyEnv: ZAI_BACKUP_API_KEY
`;
    const zaiManifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(zaiYaml, 'utf8'), format: 'yaml' });
    assert.equal(zaiManifest.spec.models?.length, 2);
    assert.equal(zaiManifest.spec.models?.[0]?.provider, 'zai');
    assert.equal(zaiManifest.spec.models?.[0]?.id, 'glm-5.3');
    assert.equal(zaiManifest.spec.models?.[1]?.provider, 'zai-coding-cn');

    // Legacy singular spec.model and empty spec.models: [] are rejected
    assert.throws(
      () => validateTaskpackManifest(editedManifest(zaiManifest, draft => {
        delete (draft['spec'] as Record<string, unknown>)['models'];
        (draft['spec'] as Record<string, unknown>)['model'] = { provider: 'zai', id: 'glm-5.3' };
      })),
      (err: GitHubAppError) => err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(editedManifest(zaiManifest, draft => {
        (draft['spec'] as Record<string, unknown>)['models'] = [];
      })),
      (err: GitHubAppError) => err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/models',
    );

    const compiledZai = await compileDeclarativeTaskpack(zaiManifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      budgets: DEFAULT_HOST_BUDGETS,
      publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
      credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
    });
    assert.deepEqual(compiledZai.registry.spec.roleProfiles[0]?.selection, {
      provider: 'zai',
      model: 'glm-5.3',
      thinking: 'high',
      api: 'openai-completions',
    });
    const zaiArtifacts = await writeTrustedArtifacts(compiledZai.registryBytes, Buffer.from(serializePrettyYaml(compiledZai.config), 'utf8'));
    const loadedZai = await loadTrustedConfiguration({
      configPath: zaiArtifacts.configPath,
      registryPath: zaiArtifacts.registryPath,
      registrySha256: compiledZai.registrySha256,
      untrustedRoots: [],
    });
    assert.equal(loadedZai.ok, true);
    if (loadedZai.ok) {
      const planZai = await compilePlan(loadedZai.value);
      assert.equal(planZai.ok, true);
    }

    // Compiling candidateIndex: 1 selects the fallback provider/model entry
    const compiledFallback = await compileDeclarativeTaskpack(zaiManifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      candidateIndex: 1,
      budgets: DEFAULT_HOST_BUDGETS,
      publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
      credentialEnvMap: { provider: 'ZAI_BACKUP_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
    });
    assert.equal(compiledFallback.registry.spec.roleProfiles[0]?.selection.provider, 'zai-coding-cn');

    // Single-candidate fast path makes 0 probe requests; multi-candidate probe skips 1113/402/429 and selects healthy fallback
    const singleCandidates = resolveTaskpackModelCandidates(
      await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' }),
      {
        mode: 'candidate',
        repository: 'octocat/target',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
      },
      { env: { ZAI_API_KEY: 'single_zai_token_123456' } },
    );
    assert.equal(singleCandidates.length, 1);
    let singleProbeCalls = 0;
    const singleSelected = await selectHealthyModelCandidate(singleCandidates, {
      fetchImpl: async () => {
        singleProbeCalls += 1;
        throw new Error('single candidate must not probe');
      },
    });
    assert.equal(singleProbeCalls, 0);
    assert.equal(singleSelected.probed, false);
    assert.equal(singleSelected.index, 0);

    // Multi-candidate + comma-separated token expansion + readiness probe (ZAI 1113 quota + HTTP 402 -> healthy backup)
    const scrubber = new SecretScrubber();
    const multiCandidates = resolveTaskpackModelCandidates(
      zaiManifest,
      {
        mode: 'candidate',
        repository: 'octocat/target',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
      },
      {
        env: {
          ZAI_API_KEY: 'tok_quota_1113_aaaa, tok_balance_402_bbbb',
          ZAI_BACKUP_API_KEY: 'tok_healthy_cn_cccc',
        },
        scrubber,
      },
    );
    assert.equal(multiCandidates.length, 3);
    assert.equal(multiCandidates[0]?.usesActiveTokenEnv, true);
    assert.equal(multiCandidates[1]?.usesActiveTokenEnv, true);
    assert.equal(multiCandidates[2]?.usesActiveTokenEnv, false);
    assert.equal(scrubber.scrub('leak tok_quota_1113_aaaa and tok_balance_402_bbbb and tok_healthy_cn_cccc'), 'leak [scrubbed] and [scrubbed] and [scrubbed]');

    const probeAuthHeaders: string[] = [];
    const multiSelected = await selectHealthyModelCandidate(multiCandidates, {
      scrubber,
      fetchImpl: async (_url, init) => {
        const headers = init?.headers as Record<string, string>;
        const auth = headers['authorization'] ?? '';
        probeAuthHeaders.push(auth);
        if (auth.includes('tok_quota_1113_aaaa')) {
          return new Response(JSON.stringify({ error: { code: '1113', message: 'Insufficient balance or no resource package' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (auth.includes('tok_balance_402_bbbb')) {
          return new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Payment required' } }), {
            status: 402,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ id: 'probe-ok', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    assert.equal(probeAuthHeaders.length, 3);
    assert.equal(multiSelected.probed, true);
    assert.equal(multiSelected.index, 2);
    assert.equal(multiSelected.selected.selection.provider, 'zai-coding-cn');
    assert.equal(multiSelected.attempts[0]?.reason, 'http_400_1113');
    assert.equal(multiSelected.attempts[1]?.reason, 'http_402_insufficient_quota');

    // Custom OpenAI-compatible gateway for glm-5.3 via spec.models + allowManifestCustomBaseUrl
    const customYaml = `${VALID_MANIFEST_YAML}  models:
    - provider: custom-glm-gateway
      id: glm-5.3
      thinking: high
      api: openai-completions
      baseUrl: https://gateway.example.test/v1
      contextWindow: 204800
      maxTokens: 32768
      reasoning: true
      samplingParams:
        temperature: 0.6
        top_p: 0.95
      compat:
        thinkingFormat: zai
        maxTokensField: max_tokens
        zaiToolStream: true
`;
    const customManifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(customYaml, 'utf8'), format: 'yaml' });
    // Without allowManifestCustomBaseUrl, untrusted manifest baseUrl is refused (even in fallback positions)
    await assert.rejects(
      compileDeclarativeTaskpack(customManifest, {
        mode: 'candidate',
        repository: 'octocat/target',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
      }),
      (err: GitHubAppError) => err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    // With allowManifestCustomBaseUrl: true, custom compatible provider compiles and passes controller compilePlan
    const compiledCustom = await compileDeclarativeTaskpack(customManifest, {
      mode: 'candidate',
      repository: 'octocat/target',
      baseRevision: 'b'.repeat(40),
      sourceRevision: 'a'.repeat(40),
      allowManifestCustomBaseUrl: true,
      budgets: DEFAULT_HOST_BUDGETS,
      publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
      credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
    });
    assert.equal(compiledCustom.registry.spec.roleProfiles[0]?.selection.provider, 'custom-glm-gateway');
    assert.equal(compiledCustom.registry.spec.roleProfiles[0]?.selection.customProvider?.baseUrl, 'https://gateway.example.test/v1');
    assert.equal(compiledCustom.registry.spec.roleProfiles[0]?.selection.customProvider?.compat?.thinkingFormat, 'zai');
    const customArtifacts = await writeTrustedArtifacts(compiledCustom.registryBytes, Buffer.from(serializePrettyYaml(compiledCustom.config), 'utf8'));
    const loadedCustom = await loadTrustedConfiguration({
      configPath: customArtifacts.configPath,
      registryPath: customArtifacts.registryPath,
      registrySha256: compiledCustom.registrySha256,
      untrustedRoots: [],
    });
    assert.equal(loadedCustom.ok, true);
    if (loadedCustom.ok) {
      const planCustom = await compilePlan(loadedCustom.value);
      assert.equal(planCustom.ok, true);
    }

    // Pi models.json custom provider + refusal of OAuth and !command
    await withSandbox(async root => {
      const modelsJsonPath = join(root, 'models.json');
      await writeFile(modelsJsonPath, JSON.stringify({
        $schema: 'https://pi.dev/schemas/models.schema.json',
        providers: {
          'self-hosted-zai': {
            baseUrl: 'https://llm.internal.example/v1',
            api: 'openai-completions',
            apiKey: '$ZAI_API_KEY',
            models: [{ id: 'glm-5.3', reasoning: true, contextWindow: 128000, maxTokens: 16384, compat: { thinkingFormat: 'zai' } }],
          },
        },
      }), { mode: 0o600 });
      const plainManifest = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
      const fromModelsJson = await compileDeclarativeTaskpack(plainManifest, {
        mode: 'candidate',
        repository: 'octocat/target',
        baseRevision: 'b'.repeat(40),
        sourceRevision: 'a'.repeat(40),
        roleSelection: { provider: 'self-hosted-zai', model: 'glm-5.3', thinking: 'high' },
        modelsJsonPath,
        budgets: DEFAULT_HOST_BUDGETS,
        publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
        credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
      });
      assert.equal(fromModelsJson.registry.spec.roleProfiles[0]?.selection.customProvider?.baseUrl, 'https://llm.internal.example/v1');

      const badShellModelsPath = join(root, 'bad-shell-models.json');
      await writeFile(badShellModelsPath, JSON.stringify({
        providers: {
          'self-hosted-zai': {
            baseUrl: 'https://llm.internal.example/v1',
            api: 'openai-completions',
            apiKey: '!op read op://vault/key',
            models: [{ id: 'glm-5.3' }],
          },
        },
      }), { mode: 0o600 });
      await assert.rejects(
        compileDeclarativeTaskpack(plainManifest, {
          mode: 'candidate',
          repository: 'octocat/target',
          baseRevision: 'b'.repeat(40),
          sourceRevision: 'a'.repeat(40),
          roleSelection: { provider: 'self-hosted-zai', model: 'glm-5.3', thinking: 'high' },
          modelsJsonPath: badShellModelsPath,
          budgets: DEFAULT_HOST_BUDGETS,
          publicationEndpoint: { id: 'docs-publication', url: 'https://publisher.example.test/publish', signingCredentialRef: 'docs-publication-signing' },
          credentialEnvMap: { provider: 'ZAI_API_KEY', publication: 'TASKPACK_TEST_PUBLICATION_SIGNING_SECRET' },
        }),
        (err: GitHubAppError) => err.code === 'PROVIDER_OAUTH_UNSUPPORTED',
      );
    });

    // OAuth-only Pi providers are explicitly refused anywhere in spec.models[] (primary or fallback)
    for (const oauthProvider of ['github-copilot', 'gemini', 'google', 'claude-code', 'openai-codex', 'google-gemini-cli', 'google-antigravity']) {
      assert.throws(
        () => validateTaskpackManifest(editedManifest(zaiManifest, draft => {
          (draft['spec'] as Record<string, unknown>)['models'] = [
            { provider: 'zai', id: 'glm-5.3' },
            { provider: oauthProvider, id: 'some-model' },
          ];
        })),
        (err: GitHubAppError) => err.code === 'PROVIDER_OAUTH_UNSUPPORTED',
      );
    }
  });
});
