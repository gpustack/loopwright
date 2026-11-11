import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { validateDocument } from '@loopwright/core';
import { compilePlan, loadTrustedConfiguration } from '@loopwright/controller';
import { compileDeclarativeTaskpack, authorizeRepositoryActor, boundDiagnosticLog, DEFAULT_HOST_BUDGETS, loadDeclarativeTaskpack, parseActionsRunUrl, parseCommentCommand, prepareTaskpackIntake, validateCommentGuidance } from '../src/taskpack.js';
import { parseTaskpackDocument, validateTaskpackManifest, type Json } from '../src/schema.js';
import { GitHubAppError, type HostTaskpackBindings, type TaskpackManifest } from '../src/types.js';

const VALID_MANIFEST_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: TaskpackManifest
metadata:
  id: docs-sync
  name: Documentation sync
  version: '1.0.0'
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
    roleSelection: { provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh' },
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
  const registryPath = join(registryDirectory, 'registry.json');
  const configPath = join(configDirectory, 'config.json');
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
      assert.equal(manifest.metadata.id, 'docs-sync');
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

  it('enforces metadata.id, goal bounds, and upstream count limits', async () => {
    const base = await loadDeclarativeTaskpack({ bytes: Buffer.from(VALID_MANIFEST_YAML, 'utf8'), format: 'yaml' });
    assert.throws(() => validateTaskpackManifest(editedManifest(base, draft => {
      (draft.metadata as Record<string, unknown>).id = 'Docs-Sync';
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
      const { registryPath, configPath } = await writeTrustedArtifacts(compiled.registryBytes, Buffer.from(JSON.stringify(compiled.config)));
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
      const { registryPath, configPath } = await writeTrustedArtifacts(compiled.registryBytes, Buffer.from(JSON.stringify(compiled.config)));
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
      assert.equal(loaded.metadata.id, 'docs-sync');
    });
  });
});
