import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  SecretScrubber as CoreSecretScrubber,
  type Digest,
} from '@loopwright/core';
import {
  inspectRun,
  loadTrustedConfiguration,
  resolveCanonicalCasBlobPath,
  runCycleWithPorts,
  type ControllerPorts,
  type RunEvalReport,
} from '@loopwright/controller';
import {
  buildDefaultAuthorPrompt,
  collectManifestSecretEnvNames,
  compileDeclarativeTaskpack,
  createTaskpackDecisionPort,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  loadPiModelsJson,
  LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
  makeAttemptRunId,
  parseTaskpackManifest,
  resolveDefaultProviderTokenEnv,
  resolveTaskpackModelCandidates,
  SecretScrubber as TaskpackSecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  startLocalCommandGateServer,
  type CompiledTaskpack,
  type ExecutionHostPolicy,
  type HostGateEndpointPlan,
  type LocalCommandGateServer,
  type ParsedPiModelsJson,
  type ResolvedModelCandidate,
  type TaskpackManifest,
  type WrittenCompiledTaskpack,
} from '@loopwright/taskpack';
import type {
  CandidateEvaluationProposal,
  CandidateEvaluationResult,
  CandidateEvaluator,
  IndividualStatus,
  ReadOnlySupervisorTurnContext,
  SupervisorRunnerPort,
} from '@loopwright/evolution';
import type { DecisionMutationNoveltyResult } from '@loopwright/decisions';

type OpenPiHostSessionAdapterV2Fn = typeof import('@loopwright/agent-pi/host-session')['openPiHostSessionAdapterV2'];
type EvolutionModule = typeof import('@loopwright/evolution');

function createLazyHostSessionLoader(): () => Promise<OpenPiHostSessionAdapterV2Fn> {
  let promise: Promise<OpenPiHostSessionAdapterV2Fn> | null = null;
  return () => {
    promise ??= import('@loopwright/agent-pi/host-session').then(mod => mod.openPiHostSessionAdapterV2);
    return promise;
  };
}

async function writeCompiledEvolutionDir(
  trustedDirectory: string,
  compiled: CompiledTaskpack,
  proposal: CandidateEvaluationProposal,
  scrubber: TaskpackSecretScrubber,
  evolution: EvolutionModule,
): Promise<WrittenCompiledTaskpack> {
  const registryDirectory = join(trustedDirectory, 'registry');
  const configDirectory = join(trustedDirectory, 'config');
  await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(trustedDirectory, 0o700);
  await chmod(registryDirectory, 0o700);
  await chmod(configDirectory, 0o700);

  const extraResources: Array<{
    readonly id: string;
    readonly kind: 'document';
    readonly path: string;
    readonly digest: Digest;
  }> = [];

  if (proposal.stagedParentFiles.length > 0) {
    const parentResDir = join(registryDirectory, '.loopwright-evo', 'parents');
    await mkdir(parentResDir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < proposal.stagedParentFiles.length; i += 1) {
      const pf = proposal.stagedParentFiles[i]!;
      const relPath = `.loopwright-evo/parents/parent-${i}.json`;
      const dstPath = join(registryDirectory, relPath);
      const bytes = await readFile(pf.filePath);
      await writeFile(dstPath, bytes, { mode: 0o400 });
      await chmod(dstPath, 0o400);
      extraResources.push({
        id: `evo-parent-${i}`,
        kind: 'document',
        path: relPath,
        digest: pf.digest,
      });
    }
  }

  if (proposal.stagedScratchpadPath !== undefined) {
    const scDir = join(registryDirectory, '.loopwright-evo', 'scratchpad');
    await mkdir(scDir, { recursive: true, mode: 0o700 });
    const scBytes = await readFile(proposal.stagedScratchpadPath);
    const relPath = '.loopwright-evo/scratchpad/latest.md';
    const dstPath = join(registryDirectory, relPath);
    await writeFile(dstPath, scBytes, { mode: 0o400 });
    await chmod(dstPath, 0o400);
    extraResources.push({
      id: 'evo-scratchpad',
      kind: 'document',
      path: relPath,
      digest: evolution.sha256Digest(scBytes),
    });
  }

  const patchRoleById = new Map(
    (proposal.teamPatch?.roles ?? []).map(r => [r.id, r] as const),
  );
  const updatedRoleProfiles = compiled.registry.spec.roleProfiles.map(prof => {
    for (const [rId, pr] of patchRoleById.entries()) {
      if ((prof.id === rId || prof.id === `taskpack.profile.${rId}`) && pr.timeoutSeconds !== undefined) {
        const requestedWallMs = pr.timeoutSeconds * 1000;
        const currentWallMs = prof.limits?.toolWallMs;
        const narrowedWallMs = currentWallMs !== undefined ? Math.min(currentWallMs, requestedWallMs) : requestedWallMs;
        return {
          ...prof,
          limits: {
            ...prof.limits,
            toolWallMs: narrowedWallMs,
          },
        };
      }
    }
    return prof;
  });

  const finalRegistry = {
    ...compiled.registry,
    spec: {
      ...compiled.registry.spec,
      resources: extraResources.length > 0
        ? [...compiled.registry.spec.resources, ...extraResources]
        : compiled.registry.spec.resources,
      roleProfiles: updatedRoleProfiles,
    },
  };
  const registryBytes = Buffer.from(`${JSON.stringify(finalRegistry, null, 2)}\n`, 'utf8');
  const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');

  const extraResourceIds = extraResources.map(r => r.id);
  const updatedTaskRoles = compiled.config.spec.task.spec.roles.map(role => {
    const pr = patchRoleById.get(role.id);
    const baseResIds = pr?.resourceIds !== undefined ? [...pr.resourceIds] : role.resourceIds;
    if (baseResIds === undefined) {
      return role;
    }
    const mergedResIds = extraResourceIds.length > 0
      ? Array.from(new Set([...baseResIds, ...extraResourceIds]))
      : Array.from(new Set(baseResIds));
    return {
      ...role,
      resourceIds: mergedResIds,
    };
  });

  const finalTask = {
    ...compiled.config.spec.task,
    spec: {
      ...compiled.config.spec.task.spec,
      roles: updatedTaskRoles,
      trustedContext: extraResources.length > 0
        ? {
          ...compiled.config.spec.task.spec.trustedContext,
          resources: [...compiled.config.spec.task.spec.trustedContext.resources, ...extraResources],
        }
        : compiled.config.spec.task.spec.trustedContext,
    },
  };

  const finalConfig = {
    ...compiled.config,
    spec: {
      ...compiled.config.spec,
      registry: {
        name: finalRegistry.metadata.name,
        digest: { algorithm: 'sha256' as const, hex: registrySha256 },
      },
      task: finalTask,
    },
  };

  const configBytes = Buffer.from(serializePrettyYaml(finalConfig), 'utf8');
  const scrubCheck = (bytes: Buffer, label: string): void => {
    const text = bytes.toString('utf8');
    if (scrubber.containsSecret(text)) {
      throw new Error(`secret pattern detected in compiled ${label}`);
    }
  };
  scrubCheck(registryBytes, 'registry');
  scrubCheck(configBytes, 'config');

  const registryPath = join(registryDirectory, 'registry.yaml');
  const configPath = join(configDirectory, 'config.yaml');
  await writeFile(registryPath, registryBytes, { mode: 0o600 });
  await writeFile(configPath, configBytes, { mode: 0o600 });
  await chmod(registryPath, 0o600);
  await chmod(configPath, 0o600);
  if (compiled.instructionResources !== undefined && compiled.instructionResources.length > 0) {
    await stageCompiledInstructionResources(registryDirectory, compiled.instructionResources);
  }

  return {
    ...compiled,
    registry: finalRegistry,
    registryBytes,
    registrySha256,
    config: finalConfig,
    configBytes,
    trustedDirectory,
    registryPath,
    configPath,
  };
}

async function extractSliceFromWorkspaceDir(
  workspaceDir: string,
  fallbackRepoDir: string,
  guardedFiles: readonly string[],
  fallbackId: string,
  evolution: EvolutionModule,
): Promise<string> {
  if (guardedFiles.length === 0) {
    return `// individual:${fallbackId}\n`;
  }
  const slices: string[] = [];
  for (const rel of guardedFiles) {
    const content = await readFile(join(workspaceDir, rel), 'utf8')
      .catch(() => readFile(join(fallbackRepoDir, rel), 'utf8').catch(() => ''));
    if (content.length > 0) {
      slices.push(evolution.extractEvolveBlocksFromSource(content));
    }
  }
  return slices.length > 0 ? slices.join('\n') : `// individual:${fallbackId}\n`;
}

async function extractCandidateGuardedCodeSlice(
  controllerRunRoot: string,
  attemptRunId: string,
  childRepoDir: string,
  guardedFiles: readonly string[],
  fallbackId: string,
  evolution: EvolutionModule,
): Promise<string> {
  if (guardedFiles.length === 0) {
    return `// individual:${fallbackId}\n`;
  }
  const artifactsDir = join(controllerRunRoot, attemptRunId, 'artifacts');
  const tmpHolder = await mkdtemp(join(await realpath(tmpdir()), 'lw-evo-cand-inspect-'));
  const fileDigestMap = new Map<string, string>();
  const fileContentMap = new Map<string, string>();
  try {
    const inspected = await inspectRun({
      runRoot: controllerRunRoot,
      runId: attemptRunId,
      output: join(tmpHolder, 'bundle'),
    }).catch(() => null);
    if (inspected !== null && inspected.ok) {
      const rawCandidate = await readFile(join(tmpHolder, 'bundle', 'candidate.files.json'), 'utf8').catch(() => null);
      if (rawCandidate !== null) {
        const parsed = JSON.parse(rawCandidate) as {
          readonly files?: readonly {
            readonly name?: unknown;
            readonly sha256?: unknown;
            readonly encoding?: unknown;
            readonly body?: unknown;
          }[];
        };
        if (Array.isArray(parsed.files)) {
          for (const entry of parsed.files) {
            if (typeof entry.name !== 'string') continue;
            if (typeof entry.sha256 === 'string') {
              fileDigestMap.set(entry.name, entry.sha256);
            } else if (entry.encoding === 'base64' && typeof entry.body === 'string') {
              fileContentMap.set(entry.name, Buffer.from(entry.body, 'base64').toString('utf8'));
            }
          }
        }
      }
    }
  } finally {
    await rm(tmpHolder, { recursive: true, force: true }).catch(() => undefined);
  }

  const slices: string[] = [];
  for (const rel of guardedFiles) {
    let content = fileContentMap.get(rel) ?? '';
    if (content.length === 0) {
      const hex = fileDigestMap.get(rel);
      if (hex !== undefined) {
        const casPath = await resolveCanonicalCasBlobPath(artifactsDir, hex).catch(() => null);
        if (casPath !== null) {
          content = await readFile(casPath, 'utf8').catch(() => '');
        }
      }
    }
    if (content.length === 0) {
      content = await readFile(join(childRepoDir, rel), 'utf8').catch(() => '');
    }
    if (content.length > 0) {
      slices.push(evolution.extractEvolveBlocksFromSource(content));
    }
  }
  return slices.length > 0 ? slices.join('\n') : `// individual:${fallbackId}\n`;
}

function buildEffectiveEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  ephemeralEnv: Readonly<Record<string, string>>,
  scrubber: TaskpackSecretScrubber,
): Record<string, string | undefined> {
  const effectiveEnv: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value !== undefined) {
      effectiveEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(ephemeralEnv)) {
    effectiveEnv[key] = value;
    if (value.length > 0) scrubber.register(value);
  }
  const activeToken = effectiveEnv[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
  if (typeof activeToken === 'string' && activeToken.length > 0) {
    scrubber.register(activeToken);
  }
  return effectiveEnv;
}

function createEvolutionOpenAdapter(options: {
  readonly writtenTaskpack: WrittenCompiledTaskpack;
  readonly effectiveEnv: Readonly<Record<string, string | undefined>>;
  readonly scrubber: TaskpackSecretScrubber;
  readonly openPiHostSessionAdapterV2: OpenPiHostSessionAdapterV2Fn;
  readonly onAfterExecute?: ((candidateDir: string, stepId: string, roleId: string) => Promise<void> | void) | undefined;
  readonly onAfterCapture?: ((artifactsDirectory: string, sessionArtifactName: string) => Promise<void> | void) | undefined;
}): NonNullable<ControllerPorts['openAdapter']> {
  const { writtenTaskpack, effectiveEnv, scrubber, openPiHostSessionAdapterV2, onAfterExecute, onAfterCapture } = options;

  return async (host, adapterInput) => {
    const wrappedHost = {
      ...host,
      resolveCredential: async (binding: Parameters<typeof host.resolveCredential>[0]) => {
        try {
          const bound = await host.resolveCredential(binding);
          if (bound.bearerToken.length > 0) return bound;
        } catch {
          // Fall through to active candidate token only for taskpack provider bindings.
        }
        const bindingMeta = binding as { readonly env?: unknown; readonly ref?: unknown };
        const hasExplicitMeta = bindingMeta.env !== undefined || bindingMeta.ref !== undefined;
        const boundRoleMapping = writtenTaskpack.config.spec.profiles.roles.find(
          item => item.roleId === adapterInput.roleId,
        );
        const roleProfile = boundRoleMapping === undefined
          ? undefined
          : writtenTaskpack.registry.spec.roleProfiles.find(
            item => item.id === boundRoleMapping.profileRef,
          );
        const explicitEntry = hasExplicitMeta
          ? writtenTaskpack.registry.spec.credentialBindings.find(entry =>
            entry.consumer === 'provider'
            && (
              (typeof bindingMeta.ref === 'string' && entry.id === bindingMeta.ref)
              || (typeof bindingMeta.env === 'string' && entry.environmentNames.includes(bindingMeta.env))
            ))
          : undefined;
        const matchesExplicitMeta =
          bindingMeta.env === LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV
          || bindingMeta.ref === 'taskpack-provider-token'
          || (explicitEntry?.environmentNames.includes(LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV) ?? false);
        const matchesRegistryProviderBinding = writtenTaskpack.registry.spec.credentialBindings.some(entry =>
          entry.consumer === 'provider'
          && entry.destinationRef === binding.provider
          && (roleProfile?.providerCredentialRef === undefined || entry.id === roleProfile.providerCredentialRef)
          && (entry.id === 'taskpack-provider-token' || entry.environmentNames.includes(LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV)),
        );
        if ((hasExplicitMeta && matchesExplicitMeta) || (!hasExplicitMeta && matchesRegistryProviderBinding)) {
          const active = effectiveEnv[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV];
          if (typeof active === 'string' && active.length > 0) {
            return { bearerToken: active };
          }
        }
        throw new Error('missing provider credential for active candidate');
      },
    };

    const opened = await openPiHostSessionAdapterV2(wrappedHost, adapterInput, {
      scrub: text => scrubber.scrub(text),
    });
    if (!opened.ok) {
      return opened;
    }

    const inner = opened.value;
    const sessionCandidateDir = join(host.directory, `sdk-${adapterInput.sessionId}`, 'candidate');
    return {
      ok: true,
      value: {
        capabilities: () => inner.capabilities(),
        events: () => inner.events(),
        close: () => inner.close(),
        cancel: input => inner.cancel(input),
        compact: input => inner.compact(input),
        execute: async input => {
          const res = await inner.execute(input);
          if (res.ok && res.value.status === 'execution_settled' && onAfterExecute !== undefined) {
            await onAfterExecute(sessionCandidateDir, adapterInput.stepId, adapterInput.roleId);
          }
          return res;
        },
        capture: async input => {
          const res = await inner.capture(input);
          if (res.ok && onAfterCapture !== undefined) {
            await onAfterCapture(host.artifactsDirectory, res.value.session.name);
          }
          return res;
        },
      },
    };
  };
}

function extractLastAssistantTextFromSessionJsonl(sessionText: string): string | null {
  const lines = sessionText.split('\n');
  let lastAssistantText: string | null = null;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as { readonly type?: unknown; readonly message?: unknown };
    if (rec.type !== 'message' || rec.message === null || typeof rec.message !== 'object') continue;
    const msg = rec.message as { readonly role?: unknown; readonly content?: unknown };
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') {
      lastAssistantText = msg.content;
    } else if (Array.isArray(msg.content)) {
      let combined = '';
      for (const block of msg.content) {
        if (block !== null && typeof block === 'object') {
          const b = block as { readonly type?: unknown; readonly text?: unknown };
          if (b.type === 'text' && typeof b.text === 'string') {
            combined += b.text;
          }
        }
      }
      if (combined.length > 0) {
        lastAssistantText = combined;
      }
    }
  }
  return lastAssistantText;
}

function unwrapOptionalJsonCodeFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
  return fenced !== null ? fenced[1]!.trim() : trimmed;
}

/**
 * Create a lazy-loaded Pi-backed `CandidateEvaluator` for CLI `evolve run` and `evolve resume`.
 */
export function createCliEvolutionEvaluator(options: {
  readonly repositoryRoot: string;
  readonly coreScrubber: CoreSecretScrubber;
  readonly taskpackScrubber: TaskpackSecretScrubber;
}): CandidateEvaluator {
  const openPiHostSessionPromise = createLazyHostSessionLoader();

  const resolvedBaseRepo = resolve(options.repositoryRoot);
  const coreScrubber = options.coreScrubber;
  const taskpackScrubber = options.taskpackScrubber;
  const registerSecret = (val: string): void => {
    if (val.length > 0) {
      coreScrubber.register(val);
      taskpackScrubber.register(val);
    }
  };

  return async (proposal: CandidateEvaluationProposal): Promise<CandidateEvaluationResult> => {
    const evolution = await import('@loopwright/evolution');
    const openPiHostSessionAdapterV2 = await openPiHostSessionPromise();

    await mkdir(proposal.childRunDir, { recursive: true, mode: 0o700 });
    const childRunDir = await realpath(proposal.childRunDir);
    const realBaseRepo = await realpath(resolvedBaseRepo);
    const childRepoDir = join(childRunDir, 'repo');
    const controllerRunRoot = join(childRunDir, 'controller');
    const runId = evolution.sanitizeRunId(proposal.individualId);
    const attemptRunId = makeAttemptRunId(runId, 0);

    await evolution.materializeGitCheckoutNoFollow(realBaseRepo, childRepoDir);

    const scopedTaskpack = evolution.buildStageScopedTaskpack({
      taskpack: proposal.taskpack,
      heldOutWorkloadId: proposal.heldOutWorkloadId,
      targetCellId: proposal.manifest.spec.targetCellId,
      ...(proposal.teamPatch !== undefined ? { teamPatch: proposal.teamPatch } : {}),
    });

    for (const envName of collectManifestSecretEnvNames(scopedTaskpack)) {
      const val = process.env[envName];
      if (typeof val === 'string' && val.length > 0) registerSecret(val);
    }

    const modelsJsonPath = process.env['LOOPWRIGHT_MODELS_JSON']?.trim() || undefined;
    const modelsConfig: ParsedPiModelsJson | undefined = modelsJsonPath !== undefined
      ? await loadPiModelsJson(modelsJsonPath)
      : undefined;
    const allowManifestCustomBaseUrl = process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'] === 'true';

    const gateEndpoints: HostGateEndpointPlan[] = [];
    const byCredentialRef: Record<string, string> = {};
    const benchmarkGateEnvUrl = process.env['LOOPWRIGHT_BENCHMARK_GATE_URL']?.trim();
    const defaultBenchSecretEnv = process.env['LOOPWRIGHT_GATE_SIGNING_SECRET']?.trim()
      ? 'LOOPWRIGHT_GATE_SIGNING_SECRET'
      : process.env['BENCH_SIGNING_SECRET']?.trim()
        ? 'BENCH_SIGNING_SECRET'
        : 'LOOPWRIGHT_GATE_SIGNING_SECRET';

    for (const extGate of scopedTaskpack.spec.verification.externalGates) {
      if (extGate.implementation !== 'benchmark-gate.v1') continue;
      const url = extGate.url ?? benchmarkGateEnvUrl;
      if (url === undefined || url.length === 0) continue;
      const signingRef = extGate.signingCredentialRef ?? 'bench-sign';
      byCredentialRef[signingRef] = defaultBenchSecretEnv;
      if (extGate.authCredentialRef !== undefined) {
        byCredentialRef[extGate.authCredentialRef] = 'LOOPWRIGHT_GATE_AUTH_TOKEN';
      }
      gateEndpoints.push({
        id: extGate.endpointId,
        url: new URL(url).href,
        signingCredentialRef: signingRef,
        ...(extGate.authCredentialRef !== undefined ? { authCredentialRef: extGate.authCredentialRef } : {}),
        implementation: 'benchmark-gate.v1',
        timeoutMs: 10_000,
        maxPollMs: 30_000,
        pollInitialMs: 100,
        pollMaxMs: 500,
        jitter: 25,
      });
    }

    const hostPolicy: ExecutionHostPolicy = {
      policyProfile: 'local',
      allowWorkflowWrites: false,
    };

    const acceptanceCheckIds = [
      ...scopedTaskpack.spec.verification.localChecks.map(c => c.id),
      ...scopedTaskpack.spec.verification.externalGates.map(g => g.id),
    ];

    const declaredModels = scopedTaskpack.spec.models ?? [];
    const matchingModelIdx = declaredModels.findIndex(m => m.id === proposal.modelId);
    const selectedModelDecl = matchingModelIdx >= 0 ? declaredModels[matchingModelIdx] : declaredModels[0];

    const stagePromptSuffix = proposal.stagePhase === 'portfolio'
      ? `\n\nEvolution stage: portfolio synthesis (track: ${proposal.trackId}, specialists: ${proposal.portfolioSpecialists?.length ?? 0}).`
      : `\n\nEvolution stage: specialist${proposal.bucketId !== null ? ` (bucket: ${proposal.bucketId})` : ''} (track: ${proposal.trackId}, mutation: ${proposal.mutationKind}).`;
    const baseAuthorPrompt = buildDefaultAuthorPrompt({
      mode: 'candidate',
      repositoryFullName: 'local/evolution',
      acceptanceCheckIds,
      runtimeEnv: process.env,
      scrubber: taskpackScrubber,
    }) + stagePromptSuffix;

    const buildBindings = (
      activeCandidate?: ResolvedModelCandidate,
      activeGateEndpoints: readonly HostGateEndpointPlan[] = gateEndpoints,
    ) => {
      const providerForEnv = activeCandidate?.selection.provider ?? selectedModelDecl?.provider;
      const providerEnvName = activeCandidate?.providerEnvName
        ?? (providerForEnv !== undefined
          ? resolveDefaultProviderTokenEnv(providerForEnv, {
              modelsJsonApiKeyEnv: modelsConfig?.providers.get(providerForEnv)?.apiKeyEnv,
              manifestApiKeyEnv: selectedModelDecl?.apiKeyEnv,
              env: process.env,
            })
          : undefined);
      return {
        mode: 'candidate' as const,
        hostPolicy,
        repository: 'local/evolution',
        repositoryRoot: childRepoDir,
        taskpackPath: proposal.manifest.spec.taskpack,
        baseRevision: proposal.baseRevision,
        sourceRevision: proposal.baseRevision,
        targetMatrix: scopedTaskpack.spec.target?.matrix ?? null,
        ...(matchingModelIdx >= 0 ? { candidateIndex: matchingModelIdx } : {}),
        allowManifestCustomBaseUrl,
        ...(modelsJsonPath !== undefined ? { modelsJsonPath } : {}),
        budgets: {
          ...DEFAULT_HOST_BUDGETS,
          overlay: {
            maxFiles: Math.max(256, scopedTaskpack.spec.limits?.overlay?.maxFiles ?? 0),
            maxBytes: Math.max(16_777_216, scopedTaskpack.spec.limits?.overlay?.maxBytes ?? 0),
          },
        },
        gateEndpoints: activeGateEndpoints,
        publicationEndpoint: null,
        credentialEnvMap: {
          ...(providerEnvName !== undefined ? { provider: providerEnvName } : {}),
          gate: defaultBenchSecretEnv,
          localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
          ...(Object.keys(byCredentialRef).length > 0 ? { byCredentialRef } : {}),
        },
        authorPrompt: baseAuthorPrompt,
        scrubber: taskpackScrubber,
      };
    };

    const candidates = resolveTaskpackModelCandidates(scopedTaskpack, buildBindings(), {
      modelsConfig,
      env: process.env,
      scrubber: taskpackScrubber,
    });
    const activeCandidate = (matchingModelIdx >= 0
      ? candidates.find(c => c.manifestIndex === matchingModelIdx)
      : undefined) ?? candidates[0];

    const ephemeralEnv: Record<string, string> = {};
    if (activeCandidate !== undefined && activeCandidate.usesActiveTokenEnv && activeCandidate.token !== undefined) {
      ephemeralEnv[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = activeCandidate.token;
      registerSecret(activeCandidate.token);
    }

    let localGateServer: LocalCommandGateServer | undefined;
    try {
      let compiled = await compileDeclarativeTaskpack(scopedTaskpack, buildBindings(activeCandidate));
      const localCommandGates = compiled.localCommandGates ?? [];
      if (localCommandGates.length > 0) {
        localGateServer = await startLocalCommandGateServer({
          runRoot: controllerRunRoot,
          repositoryRoot: childRepoDir,
          gates: localCommandGates,
          hostPolicy,
          runtimeEnv: process.env,
          scrubber: taskpackScrubber,
        });
        ephemeralEnv[DEFAULT_LOCAL_COMMAND_GATE_ENV] = localGateServer.signingSecret;
        compiled = await compileDeclarativeTaskpack(
          scopedTaskpack,
          buildBindings(activeCandidate, [...gateEndpoints, localGateServer.endpointPlan]),
        );
      }

      const trustedDir = join(controllerRunRoot, `trusted-${runId}`);
      const writtenTaskpack = await writeCompiledEvolutionDir(trustedDir, compiled, proposal, taskpackScrubber, evolution);
      const decisionPort = createTaskpackDecisionPort(scopedTaskpack, {
        runtimeEnv: process.env,
        scrubber: taskpackScrubber,
        hasPinnedRoles: (scopedTaskpack.spec.roles?.length ?? 0) > 0,
      });

      const evolveGuardDecl = scopedTaskpack.spec.verification.localChecks.find(
        c => c.implementation === 'evolve-block-guard.v1',
      );
      const guardedFiles = Array.isArray(evolveGuardDecl?.parameters?.['files'])
        ? (evolveGuardDecl.parameters['files'] as readonly string[])
        : [];
      const allAgentStepIds = writtenTaskpack.config.spec.task.spec.steps
        .filter(s => s.kind === 'agent')
        .map(s => s.id);

      const effectiveEnv = buildEffectiveEnv(process.env, ephemeralEnv, taskpackScrubber);
      const runRoot = dirname(writtenTaskpack.trustedDirectory);
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700).catch(() => undefined);

      const loaded = await loadTrustedConfiguration({
        configPath: writtenTaskpack.configPath,
        registryPath: writtenTaskpack.registryPath,
        registrySha256: writtenTaskpack.registrySha256,
        untrustedRoots: [childRepoDir],
        environment: name => (Object.hasOwn(effectiveEnv, name) ? effectiveEnv[name] : undefined),
      });
      if (!loaded.ok) {
        throw new evolution.EvolutionError(
          'EVOLUTION_STORE_ERROR',
          `child loadTrustedConfiguration failed: ${loaded.error.code} (${loaded.error.path})`,
        );
      }

      const cycleAbort = new AbortController();
      const onExternalAbort = (): void => {
        cycleAbort.abort();
      };
      if (proposal.signal !== undefined) {
        if (proposal.signal.aborted) {
          cycleAbort.abort();
        } else {
          proposal.signal.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      let latestCandidateSlice: string | undefined;
      let noveltyDecisionOut: DecisionMutationNoveltyResult | undefined;
      let noveltyRejectedOutcome: {
        readonly slice: string;
        readonly decision: DecisionMutationNoveltyResult;
      } | null = null;
      let noveltyScreened = false;

      const ports: ControllerPorts = {
        policyProfile: 'local',
        allowWorkflowWrites: false,
        ...(writtenTaskpack.roleMcpServers !== undefined ? { roleMcpServers: writtenTaskpack.roleMcpServers } : {}),
        ...(writtenTaskpack.watchedPaths !== undefined && writtenTaskpack.watchedPaths.length > 0
          ? { watchedPaths: writtenTaskpack.watchedPaths }
          : {}),
        ...(decisionPort !== undefined ? { decisions: decisionPort } : {}),
        openAdapter: createEvolutionOpenAdapter({
          writtenTaskpack,
          effectiveEnv,
          scrubber: taskpackScrubber,
          openPiHostSessionAdapterV2,
          onAfterExecute: async candidateDir => {
            latestCandidateSlice = await extractSliceFromWorkspaceDir(
              candidateDir,
              childRepoDir,
              guardedFiles,
              proposal.individualId,
              evolution,
            );
          },
        }),
        afterCheckpoint: async (phase, head) => {
          if (
            noveltyScreened
            || !phase.startsWith('role.')
            || !phase.endsWith('.post')
            || proposal.stagePhase === 'portfolio'
            || proposal.proposedCodeSlice !== undefined
            || (proposal.noveltyGate === undefined && (proposal.islandHistorySlices?.length ?? 0) === 0)
          ) {
            return;
          }
          const allAgentsCompleted = allAgentStepIds.length > 0
            && allAgentStepIds.every(stepId => head.progress.nodes.some(n => n.id === stepId && n.state === 'completed'));
          if (!allAgentsCompleted) {
            return;
          }
          noveltyScreened = true;
          const candidateSlice = latestCandidateSlice
            ?? await extractCandidateGuardedCodeSlice(
              runRoot,
              attemptRunId,
              childRepoDir,
              guardedFiles,
              proposal.individualId,
              evolution,
            );
          latestCandidateSlice = candidateSlice;
          const noveltyOutcome = proposal.noveltyGate !== undefined
            ? await proposal.noveltyGate(candidateSlice)
            : await evolution.screenCandidateNoveltyBeforeDispatch({
              candidateId: proposal.individualId,
              candidateSlice,
              historySlices: proposal.islandHistorySlices ?? [],
              scrubber: coreScrubber,
            });
          noveltyDecisionOut = noveltyOutcome.decision;
          if (noveltyOutcome.rejected) {
            noveltyRejectedOutcome = {
              slice: candidateSlice,
              decision: noveltyOutcome.decision,
            };
            cycleAbort.abort();
          }
        },
      };

      const childRunRelPath = `runs/${proposal.individualId}/controller/${attemptRunId}`;
      let cycleResult: Awaited<ReturnType<typeof runCycleWithPorts>>;
      try {
        cycleResult = await runCycleWithPorts(
          {
            configuration: loaded.value,
            repository: childRepoDir,
            runRoot,
            runId: attemptRunId,
            signal: cycleAbort.signal,
          },
          ports,
        );
      } finally {
        proposal.signal?.removeEventListener('abort', onExternalAbort);
      }

      if (noveltyRejectedOutcome !== null) {
        const rejected: { readonly slice: string; readonly decision: DecisionMutationNoveltyResult } = noveltyRejectedOutcome;
        return Object.freeze({
          status: 'failed' as const,
          failureReason: 'NOVELTY_CLONE_REJECTED',
          codeSlice: rejected.slice,
          metrics: Object.freeze({}),
          outputArtifacts: Object.freeze([]),
          evidenceDigest: null,
          childRunRelPath,
          noveltyDecision: rejected.decision,
        });
      }

      const extractedCodeSlice = latestCandidateSlice ?? await extractCandidateGuardedCodeSlice(
        runRoot,
        attemptRunId,
        childRepoDir,
        guardedFiles,
        proposal.individualId,
        evolution,
      );

      let runEvalReport: RunEvalReport | undefined;
      const inspectedRes = await inspectRun({
        runRoot,
        runId: attemptRunId,
      }).catch(() => null);
      if (inspectedRes !== null && inspectedRes.ok && inspectedRes.value.runEval !== null) {
        runEvalReport = inspectedRes.value.runEval;
      }

      let cycleStatus: string = 'failed';
      let cycleReasonCode: string | null = null;
      if (!cycleResult.ok) {
        cycleStatus = cycleResult.error.code === 'CANCELLED' ? 'cancelled' : 'failed';
        cycleReasonCode = cycleResult.error.code;
      } else if (cycleResult.value.kind === 'incident') {
        cycleStatus = 'failed';
        cycleReasonCode = cycleResult.value.incident.code;
      } else {
        cycleStatus = cycleResult.value.result.spec.status;
        cycleReasonCode = cycleResult.value.result.spec.verification.spec.diagnostics[0]?.code ?? null;
      }

      const runSucceeded = cycleStatus === 'completed';
      const artifactsDir = join(runRoot, attemptRunId, 'artifacts');
      const collected = await evolution.collectChildBenchmarkArtifacts(artifactsDir, runSucceeded, coreScrubber);

      let finalStatus: IndividualStatus;
      let failureReason: string | null = null;
      if (cycleStatus === 'cancelled' || proposal.signal?.aborted) {
        finalStatus = 'preempted';
        failureReason = 'CANCELLED';
      } else if (collected.retryablePreemption) {
        finalStatus = 'preempted';
        failureReason = 'BENCHMARK_PREEMPTED';
      } else if (runSucceeded) {
        finalStatus = 'passed';
        failureReason = null;
      } else {
        finalStatus = 'failed';
        failureReason = collected.dispositionReason ?? cycleReasonCode ?? 'LOCAL_VERIFICATION_FAILED';
      }

      return Object.freeze({
        status: finalStatus,
        failureReason,
        codeSlice: extractedCodeSlice,
        metrics: collected.metrics,
        ...(collected.bucketMetrics !== undefined ? { bucketMetrics: collected.bucketMetrics } : {}),
        ...(collected.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: collected.hardwareDiagnostics } : {}),
        ...(collected.hardwareProvenance !== undefined ? { hardwareProvenance: collected.hardwareProvenance } : {}),
        ...(collected.findings !== undefined ? { findings: collected.findings } : {}),
        outputArtifacts: collected.outputArtifacts,
        ...(collected.stageABlobs.length > 0 ? { stageABlobs: collected.stageABlobs } : {}),
        ...(collected.rawVerdictReceiptBytes !== undefined ? { rawVerdictReceiptBytes: collected.rawVerdictReceiptBytes } : {}),
        evidenceDigest: finalStatus === 'passed' ? evolution.sha256Digest(`${proposal.individualId}:${attemptRunId}:passed`) : null,
        childRunRelPath,
        ...(runEvalReport !== undefined ? { runEvalReport } : {}),
        ...(noveltyDecisionOut !== undefined ? { noveltyDecision: noveltyDecisionOut } : {}),
      });
    } finally {
      if (localGateServer !== undefined) {
        await localGateServer.close().catch(() => undefined);
      }
    }
  };
}

/**
 * Create a lazy-loaded, strictly read-only `LocalRunStore` Pi-backed plateau supervisor runner
 * for CLI `evolve run` and `evolve resume` (`tools: ['read']`, `scope.protected: ['**']`,
 * zero `held_out_workloads` mounts).
 */
export function createCliEvolutionSupervisorRunner(options: {
  readonly coreScrubber: CoreSecretScrubber;
  readonly taskpackScrubber: TaskpackSecretScrubber;
  readonly signal?: AbortSignal | undefined;
}): SupervisorRunnerPort {
  const openPiHostSessionPromise = createLazyHostSessionLoader();
  const coreScrubber = options.coreScrubber;
  const taskpackScrubber = options.taskpackScrubber;
  const registerSecret = (val: string): void => {
    if (val.length > 0) {
      coreScrubber.register(val);
      taskpackScrubber.register(val);
    }
  };

  return async context => {
    const evolution = await import('@loopwright/evolution');
    const runner = evolution.createLocalRunStoreSupervisorRunner({
      policyProfile: 'local',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      scrubber: coreScrubber,
      executeReadOnlySupervisorTurn: async (turn: ReadOnlySupervisorTurnContext) => {
        const openPiHostSessionAdapterV2 = await openPiHostSessionPromise();
        const supRole = turn.supervisorContract.spec.roles[0];
        if (supRole === undefined) {
          throw new evolution.EvolutionError('TEAM_ENVELOPE_VIOLATION', 'supervisor TaskContract missing role declaration');
        }

        const modelsJsonPath = process.env['LOOPWRIGHT_MODELS_JSON']?.trim() || undefined;
        const modelsConfig: ParsedPiModelsJson | undefined = modelsJsonPath !== undefined
          ? await loadPiModelsJson(modelsJsonPath)
          : undefined;
        const allowManifestCustomBaseUrl = process.env['LOOPWRIGHT_ALLOW_MANIFEST_CUSTOM_BASE_URL'] === 'true';

        const providerEnvName = resolveDefaultProviderTokenEnv(supRole.provider, {
          modelsJsonApiKeyEnv: modelsConfig?.providers.get(supRole.provider)?.apiKeyEnv,
          env: process.env,
        });

        const workspaceDir = join(turn.stagingDir, 'workspace');
        const workspaceHeadRev = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: workspaceDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().toLowerCase();

        const supervisorTaskpack: TaskpackManifest = parseTaskpackManifest(
          JSON.stringify({
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'Taskpack',
            metadata: {
              name: 'evo-supervisor',
            },
            spec: {
              goal: {
                candidate: turn.prompt,
                noChange: turn.prompt,
              },
              scope: {
                writable: ['__supervisor_readonly__/**'],
                protected: [],
              },
              models: [
                {
                  provider: supRole.provider,
                  id: supRole.model,
                  thinking: supRole.thinking,
                  ...(providerEnvName !== undefined ? { apiKeyEnv: providerEnvName } : {}),
                },
              ],
              roles: [
                {
                  id: turn.roleId,
                  provider: supRole.provider,
                  model: supRole.model,
                  thinking: supRole.thinking,
                  purpose: 'task',
                  tools: ['read'],
                  prompt: turn.prompt,
                },
              ],
              verification: {
                localChecks: [
                  {
                    id: 'supervisor-no-change',
                    implementation: 'no-change.v1',
                  },
                ],
                externalGates: [],
              },
              publication: {
                mode: 'disabled',
              },
            },
          }),
          { hostPolicy: { policyProfile: 'local', allowWorkflowWrites: false } },
        );

        const hostPolicy: ExecutionHostPolicy = {
          policyProfile: 'local',
          allowWorkflowWrites: false,
        };
        const baseBindings = {
          mode: 'no-change' as const,
          hostPolicy,
          repository: 'local/evolution',
          repositoryRoot: workspaceDir,
          baseRevision: workspaceHeadRev,
          sourceRevision: workspaceHeadRev,
          targetMatrix: null,
          allowManifestCustomBaseUrl,
          ...(modelsJsonPath !== undefined ? { modelsJsonPath } : {}),
          budgets: {
            ...DEFAULT_HOST_BUDGETS,
            wallTimeMs: 300_000,
            totalTokens: 100_000,
            maxModelCalls: 4,
            maxConcurrency: 1,
            maxFormatRepairs: 0,
            maxImplementationRepairs: 0,
          },
          gateEndpoints: [],
          publicationEndpoint: null,
          credentialEnvMap: {
            ...(providerEnvName !== undefined ? { provider: providerEnvName } : {}),
          },
          authorPrompt: turn.prompt,
          scrubber: taskpackScrubber,
        };

        const candidates = resolveTaskpackModelCandidates(supervisorTaskpack, baseBindings, {
          modelsConfig,
          env: process.env,
          scrubber: taskpackScrubber,
        });
        const activeCandidate = candidates[0];
        const ephemeralEnv: Record<string, string> = {};
        if (activeCandidate !== undefined && activeCandidate.usesActiveTokenEnv && activeCandidate.token !== undefined) {
          ephemeralEnv[LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV] = activeCandidate.token;
          registerSecret(activeCandidate.token);
        }
        const activeProviderEnvName = activeCandidate?.providerEnvName ?? providerEnvName;
        const compileBindings = {
          ...baseBindings,
          credentialEnvMap: {
            ...(activeProviderEnvName !== undefined ? { provider: activeProviderEnvName } : {}),
          },
        };

        const compiled = await compileDeclarativeTaskpack(supervisorTaskpack, compileBindings);
        const piSessionRoot = join(turn.stagingDir, 'pi-session');
        const trustedDir = join(piSessionRoot, 'trusted');
        const registryDir = join(trustedDir, 'registry');
        const configDir = join(trustedDir, 'config');
        await mkdir(registryDir, { recursive: true, mode: 0o700 });
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        await chmod(trustedDir, 0o700);
        await chmod(registryDir, 0o700);
        await chmod(configDir, 0o700);

        const stagedSupResources: Array<{
          readonly id: string;
          readonly kind: 'document';
          readonly path: string;
          readonly digest: Digest;
        }> = [];
        for (const sf of turn.files) {
          const dstPath = join(registryDir, sf.relativeResourcePath);
          await mkdir(dirname(dstPath), { recursive: true, mode: 0o700 });
          const bytes = await readFile(sf.filePath);
          await writeFile(dstPath, bytes, { mode: 0o400 });
          await chmod(dstPath, 0o400);
          stagedSupResources.push({
            id: sf.resourceId,
            kind: 'document',
            path: sf.relativeResourcePath,
            digest: sf.digest,
          });
        }

        const finalRegistry = {
          ...compiled.registry,
          spec: {
            ...compiled.registry.spec,
            resources: [...compiled.registry.spec.resources, ...stagedSupResources],
          },
        };
        const registryBytes = Buffer.from(`${JSON.stringify(finalRegistry, null, 2)}\n`, 'utf8');
        const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');

        const stagedResourceIds = stagedSupResources.map(r => r.id);
        const finalTask = {
          ...compiled.config.spec.task,
          spec: {
            ...compiled.config.spec.task.spec,
            scope: {
              ...compiled.config.spec.task.spec.scope,
              protected: Array.from(new Set(['**', ...compiled.config.spec.task.spec.scope.protected])),
            },
            roles: compiled.config.spec.task.spec.roles.map(role => ({
              ...role,
              tools: ['read'],
              resourceIds: Array.from(new Set([...(role.resourceIds ?? []), ...stagedResourceIds])),
            })),
            trustedContext: {
              ...compiled.config.spec.task.spec.trustedContext,
              resources: [...compiled.config.spec.task.spec.trustedContext.resources, ...stagedSupResources],
            },
          },
        };
        const finalConfig = {
          ...compiled.config,
          spec: {
            ...compiled.config.spec,
            registry: {
              name: finalRegistry.metadata.name,
              digest: { algorithm: 'sha256' as const, hex: registrySha256 },
            },
            task: finalTask,
          },
        };

        const configBytes = Buffer.from(serializePrettyYaml(finalConfig), 'utf8');
        if (
          taskpackScrubber.containsSecret(registryBytes.toString('utf8'))
          || taskpackScrubber.containsSecret(configBytes.toString('utf8'))
        ) {
          throw new evolution.EvolutionError(
            'SECRET_LEAK_DETECTED',
            'compiled supervisor taskpack contained a registered secret and was refused',
          );
        }
        const registryPath = join(registryDir, 'registry.yaml');
        const configPath = join(configDir, 'config.yaml');
        await writeFile(registryPath, registryBytes, { mode: 0o600 });
        await writeFile(configPath, configBytes, { mode: 0o600 });
        await chmod(registryPath, 0o600);
        await chmod(configPath, 0o600);

        const writtenSupTaskpack: WrittenCompiledTaskpack = {
          ...compiled,
          registry: finalRegistry,
          registryBytes,
          registrySha256,
          config: finalConfig,
          configBytes,
          trustedDirectory: trustedDir,
          registryPath,
          configPath,
        };

        const effectiveEnv = buildEffectiveEnv(process.env, ephemeralEnv, taskpackScrubber);
        const loaded = await loadTrustedConfiguration({
          configPath,
          registryPath,
          registrySha256,
          untrustedRoots: [workspaceDir],
          environment: name => (Object.hasOwn(effectiveEnv, name) ? effectiveEnv[name] : undefined),
        });
        if (!loaded.ok) {
          throw new evolution.EvolutionError(
            'EVOLUTION_STORE_ERROR',
            `supervisor Pi loadTrustedConfiguration failed: ${loaded.error.code} (${loaded.error.path})`,
          );
        }

        const captured: { text: string | null } = { text: null };
        let latestSupCandidateGeneration: number | null = null;
        let latestSupAttemptCount = 0;
        let latestSupHasFormatSubmissionEvidence = false;
        const supRunId = evolution.sanitizeRunId(`sup-pi-${turn.runId}`);
        const supControllerRoot = join(piSessionRoot, 'controller');
        await mkdir(supControllerRoot, { recursive: true, mode: 0o700 });

        const supCycle = await runCycleWithPorts(
          {
            configuration: loaded.value,
            repository: workspaceDir,
            runRoot: supControllerRoot,
            runId: supRunId,
            ...(turn.signal !== undefined ? { signal: turn.signal } : {}),
          },
          {
            policyProfile: 'local',
            allowWorkflowWrites: false,
            afterCheckpoint: async (_phase, head) => {
              latestSupCandidateGeneration = head.progress.candidate.generation;
              latestSupAttemptCount = head.progress.attempts.length;
              const onlyFailure = head.progress.failures.length === 1 ? head.progress.failures[0] : undefined;
              latestSupHasFormatSubmissionEvidence =
                onlyFailure !== undefined
                && onlyFailure.evidence !== null
                && head.progress.submission !== null
                && onlyFailure.evidence.digest.hex === head.progress.submission.digest.hex;
            },
            openAdapter: createEvolutionOpenAdapter({
              writtenTaskpack: writtenSupTaskpack,
              effectiveEnv,
              scrubber: taskpackScrubber,
              openPiHostSessionAdapterV2,
              onAfterCapture: async (artifactsDirectory, sessionArtifactName) => {
                const rawSession = await readFile(join(artifactsDirectory, sessionArtifactName), 'utf8').catch(() => null);
                if (rawSession !== null) {
                  const extracted = extractLastAssistantTextFromSessionJsonl(rawSession);
                  if (extracted !== null) {
                    captured.text = extracted;
                  }
                }
              },
            }),
          },
        );

        if (!supCycle.ok) {
          throw new evolution.EvolutionError(
            'TEAM_ENVELOPE_VIOLATION',
            `read-only Pi supervisor cycle failed: ${supCycle.error.code}`,
          );
        }
        if (supCycle.value.kind !== 'result') {
          throw new evolution.EvolutionError(
            'TEAM_ENVELOPE_VIOLATION',
            `read-only Pi supervisor cycle ended in incident "${supCycle.value.incident.code}"`,
          );
        }
        const supStatus = supCycle.value.result.spec.status;
        const supDiagnostics = supCycle.value.result.spec.verification.spec.diagnostics;
        // The supervisor outputs a TeamPatch JSON instead of a CandidateSubmission envelope.
        // With maxFormatRepairs=0, controller ends in status="exhausted" strictly after 1 clean
        // zero-mutation attempt whose sole failure is the raw TeamPatch submission; any other
        // failure (provider error, incident, timeout, token/call exhaustion, mutation) fails closed.
        const isExpectedTeamPatchFormatMismatch =
          supStatus === 'exhausted'
          && latestSupCandidateGeneration === 0
          && latestSupAttemptCount === 1
          && latestSupHasFormatSubmissionEvidence
          && supDiagnostics.length === 0;
        if (supStatus !== 'no_change' && supStatus !== 'completed' && !isExpectedTeamPatchFormatMismatch) {
          const codes = supDiagnostics.map(d => d.code).join(',') || 'none';
          throw new evolution.EvolutionError(
            'TEAM_ENVELOPE_VIOLATION',
            `read-only Pi supervisor cycle did not pass verification (status="${supStatus}", diagnostics=${codes})`,
          );
        }

        if (captured.text === null || captured.text.trim().length === 0) {
          throw new evolution.EvolutionError(
            'EVOLUTION_SCHEMA_INVALID',
            'read-only Pi supervisor turn produced no assistant TeamPatch response',
            '/supervisorOutput',
          );
        }

        return unwrapOptionalJsonCodeFence(captured.text);
      },
    });
    return runner(context);
  };
}
