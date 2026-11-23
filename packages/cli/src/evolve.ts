import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LIMITS,
  SecretScrubber as CoreSecretScrubber,
  type ArtifactRef,
  type BucketMetricEntry,
  type Digest,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type StructuredFinding,
} from '@loopwright/core';
import {
  inspectRun,
  resolveCanonicalCasBlobPath,
  type RunEvalReport,
} from '@loopwright/controller';
import {
  buildDefaultAuthorPrompt,
  collectManifestSecretEnvNames,
  compileDeclarativeTaskpack,
  createTaskpackDecisionPort,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  executeTurnkeyCycle,
  loadPiModelsJson,
  LOOPWRIGHT_ACTIVE_PROVIDER_TOKEN_ENV,
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
  type TaskpackRoleDeclaration,
  type TaskpackStepDeclaration,
  type TaskpackToolName,
  type WrittenCompiledTaskpack,
} from '@loopwright/taskpack';
import type {
  CandidateEvaluationProposal,
  CandidateEvaluationResult,
  CandidateEvaluator,
  IndividualStatus,
  StageABlobPayload,
  TeamPatchV1,
} from '@loopwright/evolution';

function sha256Digest(bytes: Uint8Array | string): Digest {
  return Object.freeze({
    algorithm: 'sha256' as const,
    hex: createHash('sha256').update(bytes).digest('hex'),
  });
}

function sanitizeRunId(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, LIMITS.identifier);
  return cleaned.length > 0 ? cleaned : `ind-${randomBytes(4).toString('hex')}`;
}

function extractEvolveBlocksFromSource(text: string): string {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let current: string[] = [];
  for (const line of lines) {
    if (line.includes('EVOLVE-BLOCK-START:')) {
      inBlock = true;
      current = [line];
      continue;
    }
    if (inBlock) {
      current.push(line);
      if (line.includes('EVOLVE-BLOCK-END:')) {
        blocks.push(current.join('\n'));
        inBlock = false;
        current = [];
      }
    }
  }
  return blocks.length > 0 ? `${blocks.join('\n')}\n` : text;
}

async function copyDirectoryNoFollow(
  srcDir: string,
  dstDir: string,
  EvolutionErrorCtor: typeof import('@loopwright/evolution').EvolutionError,
): Promise<void> {
  const srcStat = await lstat(srcDir);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new EvolutionErrorCtor('EVOLUTION_SYMLINK_FORBIDDEN', `source directory must be a non-symlink directory: "${srcDir}"`, srcDir);
  }
  await mkdir(dstDir, { recursive: true, mode: 0o700 });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(srcDir, entry.name);
    const dstChild = join(dstDir, entry.name);
    const st = await lstat(srcChild);
    if (st.isSymbolicLink()) {
      throw new EvolutionErrorCtor('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden inside repository tree: "${srcChild}"`, srcChild);
    }
    if (st.isDirectory()) {
      await copyDirectoryNoFollow(srcChild, dstChild, EvolutionErrorCtor);
    } else if (st.isFile()) {
      const bytes = await readFile(srcChild);
      const execBit = (st.mode & 0o111) !== 0;
      const mode = execBit ? 0o755 : 0o644;
      await writeFile(dstChild, bytes, { mode });
      if (execBit) await chmod(dstChild, 0o755);
    }
  }
}

function buildStageScopedTaskpack(
  baseTaskpack: TaskpackManifest,
  heldOutWorkloadId: string,
  teamPatch: TeamPatchV1 | undefined,
): TaskpackManifest {
  const updatedGates = baseTaskpack.spec.verification.externalGates.map(gate => {
    if (gate.implementation !== 'benchmark-gate.v1') return gate;
    return {
      ...gate,
      heldOutWorkloadId,
    };
  });

  let roles = baseTaskpack.spec.roles;
  let steps = baseTaskpack.spec.steps;

  if (teamPatch !== undefined) {
    const baseRoleById = new Map((baseTaskpack.spec.roles ?? []).map(r => [r.id, r] as const));
    const firstModel = baseTaskpack.spec.models?.[0];
    const mappedRoles: TaskpackRoleDeclaration[] = teamPatch.roles.map(pr => {
      const arch = baseRoleById.get(pr.archetypeRoleId);
      return {
        id: pr.id,
        provider: arch?.provider ?? firstModel?.provider ?? 'delegated',
        model: pr.model ?? arch?.model ?? firstModel?.id ?? 'default',
        thinking: arch?.thinking ?? firstModel?.thinking ?? 'medium',
        purpose: pr.purpose,
        prompt: pr.prompt,
        tools: [...pr.tools] as TaskpackToolName[],
        ...(pr.resourceIds !== undefined ? { resourceIds: [...pr.resourceIds] } : {}),
      };
    });

    const mappedAgentSteps: TaskpackStepDeclaration[] = teamPatch.steps.map(ps => ({
      id: ps.id,
      kind: 'agent',
      role: ps.roleId,
      dependsOn: [...ps.dependsOn],
      ...(ps.handoffs !== undefined
        ? {
          handoffs: ps.handoffs.map(h => ({
            ...(h.id !== undefined ? { id: h.id } : {}),
            fromStep: h.fromStep,
            source: (h.source as { readonly kind: string }).kind === 'assistant_final'
              ? { kind: 'submission' as const }
              : h.source,
            select: h.select,
            ...(h.maxBytes !== undefined ? { maxBytes: h.maxBytes } : {}),
            ...(h.required !== undefined ? { required: h.required } : {}),
          })),
        }
        : {}),
    }));

    const childrenCount = new Map<string, number>(teamPatch.steps.map(s => [s.id, 0] as const));
    for (const s of teamPatch.steps) {
      for (const dep of s.dependsOn) {
        childrenCount.set(dep, (childrenCount.get(dep) ?? 0) + 1);
      }
    }
    const sinkIds = teamPatch.steps.filter(s => (childrenCount.get(s.id) ?? 0) === 0).map(s => s.id);
    const checkIds = [
      ...baseTaskpack.spec.verification.localChecks.map(c => c.id),
      ...updatedGates.map(g => g.id),
    ];
    const mappedCheckSteps: TaskpackStepDeclaration[] = checkIds.map((chkId, idx) => ({
      id: `check-${chkId}`.slice(0, LIMITS.identifier),
      kind: 'check',
      check: chkId,
      dependsOn: idx === 0 ? sinkIds : [`check-${checkIds[idx - 1]!}`.slice(0, LIMITS.identifier)],
    }));

    roles = mappedRoles;
    steps = [...mappedAgentSteps, ...mappedCheckSteps];
  } else if (baseTaskpack.spec.roles !== undefined && baseTaskpack.spec.roles.length > 1 && baseTaskpack.spec.steps === undefined) {
    const mutatingTaskRoles = baseTaskpack.spec.roles.filter(
      r => (r.purpose ?? 'task') === 'task' && (r.tools === undefined || r.tools.some(t => t === 'write' || t === 'edit')),
    );
    if (mutatingTaskRoles.length >= 1) {
      const chosen = mutatingTaskRoles[0]!;
      roles = [{ ...chosen, dependsOn: [] }];
    }
  }

  return {
    ...baseTaskpack,
    spec: {
      ...baseTaskpack.spec,
      ...(roles !== undefined ? { roles } : {}),
      ...(steps !== undefined ? { steps } : {}),
      verification: {
        ...baseTaskpack.spec.verification,
        externalGates: updatedGates,
      },
    },
  };
}

async function writeCompiledEvolutionDir(
  trustedDirectory: string,
  compiled: CompiledTaskpack,
  proposal: CandidateEvaluationProposal,
  scrubber: TaskpackSecretScrubber,
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
      digest: sha256Digest(scBytes),
    });
  }

  const finalRegistry = extraResources.length > 0
    ? {
      ...compiled.registry,
      spec: {
        ...compiled.registry.spec,
        resources: [...compiled.registry.spec.resources, ...extraResources],
      },
    }
    : compiled.registry;
  const registryBytes = Buffer.from(`${JSON.stringify(finalRegistry, null, 2)}\n`, 'utf8');
  const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');

  const finalTask = extraResources.length > 0
    ? {
      ...compiled.config.spec.task,
      spec: {
        ...compiled.config.spec.task.spec,
        trustedContext: {
          ...compiled.config.spec.task.spec.trustedContext,
          resources: [...compiled.config.spec.task.spec.trustedContext.resources, ...extraResources],
        },
      },
    }
    : compiled.config.spec.task;

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

async function extractCandidateGuardedCodeSlice(
  controllerRunRoot: string,
  attemptRunId: string,
  childRepoDir: string,
  guardedFiles: readonly string[],
  fallbackId: string,
): Promise<string> {
  if (guardedFiles.length === 0) {
    return `// individual:${fallbackId}\n`;
  }
  const artifactsDir = join(controllerRunRoot, attemptRunId, 'artifacts');
  const tmpHolder = await mkdtemp(join(await realpath(tmpdir()), 'lw-evo-cand-inspect-'));
  const fileDigestMap = new Map<string, string>();
  try {
    const inspected = await inspectRun({
      runRoot: controllerRunRoot,
      runId: attemptRunId,
      output: join(tmpHolder, 'bundle'),
    }).catch(() => null);
    if (inspected !== null && inspected.ok) {
      const rawCandidate = await readFile(join(tmpHolder, 'bundle', 'candidate.files.json'), 'utf8').catch(() => null);
      if (rawCandidate !== null) {
        const parsed = JSON.parse(rawCandidate) as { readonly files?: readonly { readonly name?: unknown; readonly sha256?: unknown }[] };
        if (Array.isArray(parsed.files)) {
          for (const entry of parsed.files) {
            if (typeof entry.name === 'string' && typeof entry.sha256 === 'string') {
              fileDigestMap.set(entry.name, entry.sha256);
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
    let content = '';
    const hex = fileDigestMap.get(rel);
    if (hex !== undefined) {
      const casPath = await resolveCanonicalCasBlobPath(artifactsDir, hex).catch(() => null);
      if (casPath !== null) {
        content = await readFile(casPath, 'utf8').catch(() => '');
      }
    }
    if (content.length === 0) {
      content = await readFile(join(childRepoDir, rel), 'utf8').catch(() => '');
    }
    if (content.length > 0) {
      slices.push(extractEvolveBlocksFromSource(content));
    }
  }
  return slices.length > 0 ? slices.join('\n') : `// individual:${fallbackId}\n`;
}

/**
 * Create a lazy-loaded Pi-backed `CandidateEvaluator` for CLI `evolve run` and `evolve resume`.
 */
export function createCliEvolutionEvaluator(options: {
  readonly repositoryRoot: string;
  readonly coreScrubber: CoreSecretScrubber;
  readonly taskpackScrubber: TaskpackSecretScrubber;
}): CandidateEvaluator {
  const { openPiHostSessionPromise } = (() => {
    let promise: Promise<typeof import('@loopwright/agent-pi/host-session')['openPiHostSessionAdapterV2']> | null = null;
    return {
      openPiHostSessionPromise: () => {
        promise ??= import('@loopwright/agent-pi/host-session').then(mod => mod.openPiHostSessionAdapterV2);
        return promise;
      },
    };
  })();

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
    const runId = sanitizeRunId(proposal.individualId);

    await copyDirectoryNoFollow(realBaseRepo, childRepoDir, evolution.EvolutionError);

    const scopedTaskpack = buildStageScopedTaskpack(
      proposal.taskpack,
      proposal.heldOutWorkloadId,
      proposal.teamPatch,
    );

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
      const writtenTaskpack = await writeCompiledEvolutionDir(trustedDir, compiled, proposal, taskpackScrubber);
      const decisionPort = createTaskpackDecisionPort(scopedTaskpack, {
        runtimeEnv: process.env,
        scrubber: taskpackScrubber,
        hasPinnedRoles: (scopedTaskpack.spec.roles?.length ?? 0) > 0,
      });

      const cycleSummary = await executeTurnkeyCycle({
        runId,
        attemptSeq: 0,
        repositoryRoot: childRepoDir,
        taskpack: writtenTaskpack,
        runtimeEnv: process.env,
        ephemeralEnv,
        scrubber: taskpackScrubber,
        decisions: decisionPort,
        policyProfile: 'local',
        allowWorkflowWrites: false,
        openHostSessionAdapter: openPiHostSessionAdapterV2,
        ...(proposal.signal !== undefined ? { signal: proposal.signal } : {}),
      });

      const evolveGuardDecl = scopedTaskpack.spec.verification.localChecks.find(
        c => c.implementation === 'evolve-block-guard.v1',
      );
      const guardedFiles = Array.isArray(evolveGuardDecl?.parameters?.['files'])
        ? (evolveGuardDecl.parameters['files'] as readonly string[])
        : [];
      const extractedCodeSlice = await extractCandidateGuardedCodeSlice(
        controllerRunRoot,
        cycleSummary.attemptRunId,
        childRepoDir,
        guardedFiles,
        proposal.individualId,
      );

      let runEvalReport: RunEvalReport | undefined;
      if (cycleSummary.runEval !== null) {
        runEvalReport = cycleSummary.runEval;
      }

      const artifactsDir = join(controllerRunRoot, cycleSummary.attemptRunId, 'artifacts');
      const artifactNames = await readdir(artifactsDir).catch(() => [] as string[]);
      const benchProofFiles = artifactNames
        .filter(n => n.startsWith('benchmark-producer-') && n.endsWith('.proof.json'))
        .sort();

      let rawVerdictReceiptBytes: Uint8Array | undefined;
      let metrics: Readonly<Record<string, number>> = Object.freeze({});
      let bucketMetrics: readonly BucketMetricEntry[] | undefined;
      let hardwareDiagnostics: HardwareDiagnostics | undefined;
      let hardwareProvenance: HardwareProvenance | undefined;
      let findings: readonly StructuredFinding[] | undefined;
      let outputArtifacts: readonly ArtifactRef[] = Object.freeze([]);
      const stageABlobs: StageABlobPayload[] = [];
      let dispReason: string | null = null;
      let retryablePreemption = false;

      if (benchProofFiles.length > 0) {
        const latestProofFile = join(artifactsDir, benchProofFiles[benchProofFiles.length - 1]!);
        const proofJson = JSON.parse(await readFile(latestProofFile, 'utf8')) as Record<string, unknown>;
        const outputRef = proofJson['output'] as { readonly name?: string } | undefined;
        const outputName = outputRef?.name;
        const benchJson: Record<string, unknown> = typeof outputName === 'string' && !outputName.includes('/') && !outputName.includes('..')
          ? (JSON.parse(await readFile(join(artifactsDir, outputName), 'utf8')) as Record<string, unknown>)
          : {};
        const verdictObj = benchJson['verdict'] as Record<string, unknown> | null | undefined;
        const dispObj = benchJson['disposition'] as Record<string, unknown> | undefined;
        const responseB64 = benchJson['responseBytes'];
        const responseSigRaw = benchJson['responseSignature'];

        if (typeof responseB64 === 'string' && responseB64.length > 0) {
          const decodedBytes = Buffer.from(responseB64, 'base64');
          if (typeof responseSigRaw === 'string' && responseSigRaw.length > 0) {
            const sigHex = responseSigRaw.startsWith('sha256=') ? responseSigRaw.slice(7) : responseSigRaw;
            const parsedResp = JSON.parse(decodedBytes.toString('utf8')) as Record<string, unknown>;
            rawVerdictReceiptBytes = Buffer.from(`${evolution.canonicalizeJson({ ...parsedResp, signature: sigHex })}\n`, 'utf8');
          } else {
            rawVerdictReceiptBytes = decodedBytes;
          }
        }
        if (dispObj !== undefined && typeof dispObj['reason'] === 'string') {
          dispReason = dispObj['reason'];
        }
        if (dispObj?.['retryablePreemption'] === true || dispReason === 'BENCHMARK_PREEMPTED') {
          retryablePreemption = true;
        }
        if (verdictObj !== null && verdictObj !== undefined) {
          if (verdictObj['metrics'] !== undefined) {
            metrics = evolution.parseMetricsRecordJson(verdictObj['metrics'] as Readonly<Record<string, number>>);
          }
          if (verdictObj['bucketMetrics'] !== undefined) {
            bucketMetrics = evolution.parseBucketMetricsJson(verdictObj['bucketMetrics'] as readonly BucketMetricEntry[], coreScrubber);
          }
          if (verdictObj['hardwareDiagnostics'] !== undefined) {
            hardwareDiagnostics = evolution.parseHardwareDiagnosticsJson(verdictObj['hardwareDiagnostics'] as HardwareDiagnostics, coreScrubber);
          }
          if (verdictObj['hardwareProvenance'] !== undefined) {
            hardwareProvenance = evolution.parseHardwareProvenanceJson(verdictObj['hardwareProvenance'] as HardwareProvenance);
          }
          if (verdictObj['findings'] !== undefined) {
            findings = evolution.parseStructuredFindingsJson(verdictObj['findings'] as readonly StructuredFinding[], '/findings');
          }
          if (dispReason === null && typeof verdictObj['reason'] === 'string') {
            dispReason = verdictObj['reason'];
          }
          if (Array.isArray(verdictObj['outputArtifacts']) && cycleSummary.status === 'completed') {
            const parsedArts: ArtifactRef[] = [];
            for (const rawArt of verdictObj['outputArtifacts'] as Array<Record<string, unknown>>) {
              const name = String(rawArt['name']);
              const digObj = rawArt['digest'] as { readonly algorithm: 'sha256'; readonly hex: string };
              const byteLength = Number(rawArt['byteLength']);
              const mediaType = typeof rawArt['mediaType'] === 'string' ? rawArt['mediaType'] : undefined;
              const casPath = await resolveCanonicalCasBlobPath(artifactsDir, digObj.hex);
              const blobBytes = await readFile(casPath);
              parsedArts.push({
                name,
                digest: { algorithm: 'sha256', hex: digObj.hex },
                byteLength,
                ...(mediaType !== undefined ? { mediaType } : {}),
              });
              stageABlobs.push({
                name,
                bytes: blobBytes,
                digest: { algorithm: 'sha256', hex: digObj.hex },
                byteLength,
                ...(mediaType !== undefined ? { mediaType } : {}),
              });
            }
            outputArtifacts = Object.freeze(parsedArts);
          }
        }
      }

      let finalStatus: IndividualStatus;
      let failureReason: string | null = null;
      if (cycleSummary.status === 'cancelled' || proposal.signal?.aborted) {
        finalStatus = 'preempted';
        failureReason = 'CANCELLED';
      } else if (retryablePreemption) {
        finalStatus = 'preempted';
        failureReason = 'BENCHMARK_PREEMPTED';
      } else if (cycleSummary.status === 'completed') {
        finalStatus = 'passed';
        failureReason = null;
      } else {
        finalStatus = 'failed';
        failureReason = dispReason ?? cycleSummary.reasonCode ?? 'LOCAL_VERIFICATION_FAILED';
      }

      return Object.freeze({
        status: finalStatus,
        failureReason,
        codeSlice: extractedCodeSlice,
        metrics,
        ...(bucketMetrics !== undefined ? { bucketMetrics } : {}),
        ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
        ...(hardwareProvenance !== undefined ? { hardwareProvenance } : {}),
        ...(findings !== undefined ? { findings } : {}),
        outputArtifacts,
        ...(stageABlobs.length > 0 ? { stageABlobs: Object.freeze(stageABlobs) } : {}),
        ...(rawVerdictReceiptBytes !== undefined ? { rawVerdictReceiptBytes } : {}),
        evidenceDigest: finalStatus === 'passed' ? sha256Digest(`${proposal.individualId}:${cycleSummary.attemptRunId}:passed`) : null,
        childRunRelPath: `runs/${proposal.individualId}/controller/${cycleSummary.attemptRunId}`,
        ...(runEvalReport !== undefined ? { runEvalReport } : {}),
      });
    } finally {
      if (localGateServer !== undefined) {
        await localGateServer.close().catch(() => undefined);
      }
    }
  };
}
