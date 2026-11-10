import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import { validateDocument } from '@loopwright/core';
import { installedHandlerDigests, type ControllerConfiguration, type TrustedRegistry } from '@loopwright/controller';
import { RunnerTaskpackError } from './types.js';

/** Runner's candidate patch surface: exactly the paths the frozen validators allow a proposal to touch. */
export const RUNNER_WRITABLE_PATHS = ['pack', 'docs/supported-runners.md', 'docs/support-records.md', 'gpustack_runner/runner.py.json', '.autosync/proposal.json'] as const;
/** Runner's protected automation surface: candidate patches must never touch these paths. */
export const RUNNER_PROTECTED_PATHS = ['.github', 'tools', 'tests', '.agents', '.claude', 'AGENTS.md', 'CLAUDE.md'] as const;
/** Runner research stage budget mapped onto controller pre-admitted caps: tokens soft, everything else hard. */
export const RUNNER_BUDGETS = {
  wallTimeMs: 3300000,
  totalTokens: 20000000,
  perCallOutputTokens: 1024,
  maxModelCalls: 12,
  maxConcurrency: 1,
  maxFormatRepairs: 2,
  maxImplementationRepairs: 2,
  maxTransportRetries: 2,
} as const;
export const RUNNER_PROPOSAL_PATH = '.autosync/proposal.json';
export const RUNNER_PROPOSAL_REQUIRED_FIELDS = ['schema_version', 'identity', 'candidates', 'groups'] as const;

export interface RunnerGateEndpointPlan {
  readonly id: string;
  readonly url: string;
  readonly signingCredentialRef: string;
  readonly authCredentialRef?: string | null;
  readonly timeoutMs?: number;
  readonly maxPollMs?: number;
  readonly pollInitialMs?: number;
  readonly pollMaxMs?: number;
  readonly jitter?: number;
}

export interface RunnerPublicationEndpointPlan {
  readonly id: string;
  readonly url: string;
  readonly signingCredentialRef: string;
  readonly authCredentialRef?: string | null;
  readonly timeoutMs?: number;
}

export interface RunnerRoleSelection {
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** The frozen controller policy accepts only the anthropic-messages send path. */
  readonly api?: 'anthropic-messages';
}

export interface RunnerRuntimeOptions {
  readonly dockerExecutable?: string;
  readonly dockerSocket?: string;
  readonly imageDigest?: string;
  /** The frozen runtime profile supports only the linux/arm64 container platform. */
  readonly profile?: 'linux/arm64';
}

export interface CompileRunnerTaskpackOptions {
  readonly mode: 'candidate' | 'no-change';
  readonly repository: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly gateEndpoint: RunnerGateEndpointPlan;
  readonly publicationEndpoint?: RunnerPublicationEndpointPlan;
  readonly registryId?: string;
  readonly resourceVersion?: string;
  readonly authorPrompt?: string;
  readonly targetBranch?: string;
  readonly headBranchPrefix?: string;
  readonly titleTemplate?: string;
  readonly publication?: { readonly mode: 'disabled' };
  readonly roleSelection?: RunnerRoleSelection;
  readonly runtimeOptions?: RunnerRuntimeOptions;
}

export interface CompiledRunnerTaskpack {
  readonly registry: TrustedRegistry;
  readonly config: ControllerConfiguration;
  readonly registrySha256: string;
  readonly registryBytes: Buffer;
}

async function runtimeIdentity() {
  const described = await describePiAdapterFiles();
  if (!described.ok) throw new RunnerTaskpackError('CONFIG_INVALID', `pi adapter files could not be described: ${described.error.code}`);
  const files = described.value;
  const graphDigest = await readFile(fileURLToPath(new URL('../../../package-lock.json', import.meta.resolve('@loopwright/agent-pi'))));
  const digest = (bytes: Buffer) => ({ algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') });
  return {
    sdkIntegrity: files.sdkIntegrity,
    graphDigest: digest(graphDigest),
    configDigest: files.restrictionDigest,
    localMcpScriptDigest: files.localMcpScriptDigest,
    limits: files.limits,
  };
}

function digestOf(bytes: Buffer) {
  return { algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * Compile a Runner trigger into Loopwright documents accepted by `loadTrustedConfiguration` and `compilePlan`.
 * Signing secrets appear only inside credential and environment bindings, never in handlers, steps, or the task.
 */
export async function compileRunnerTaskpack(options: CompileRunnerTaskpackOptions): Promise<CompiledRunnerTaskpack> {
  const installed = await installedHandlerDigests();
  const runtime = await runtimeIdentity();
  const registryId = options.registryId ?? 'runner-taskpack';
  const resourceVersion = options.resourceVersion ?? 'runner-auto-sync-frozen';
  const authorPrompt = options.authorPrompt ?? 'Inspect the frozen repository snapshot and produce one structured submission with the candidate patch and proposal document.';
  const publicationEnabled = options.mode === 'candidate' && options.publication?.mode !== 'disabled';
  const publicationEndpoint = publicationEnabled ? options.publicationEndpoint : undefined;
  if (publicationEnabled && publicationEndpoint === undefined) throw new RunnerTaskpackError('CONFIG_INVALID', 'candidate mode with publication requires a publication endpoint');
  const roleSelection: Required<RunnerRoleSelection> = {
    provider: options.roleSelection?.provider ?? 'github-copilot',
    model: options.roleSelection?.model ?? 'claude-sonnet-5.5',
    thinking: options.roleSelection?.thinking ?? 'xhigh',
    api: options.roleSelection?.api ?? 'anthropic-messages',
  };
  const runtimeOptions: Required<RunnerRuntimeOptions> = {
    dockerExecutable: options.runtimeOptions?.dockerExecutable ?? '/usr/local/bin/docker',
    dockerSocket: options.runtimeOptions?.dockerSocket ?? '/var/run/docker.sock',
    imageDigest: options.runtimeOptions?.imageDigest ?? 'sha256:' + 'a'.repeat(64),
    profile: options.runtimeOptions?.profile ?? 'linux/arm64',
  };

  const candidateChecks = [
    {
      id: 'runner-proposal-json', kind: 'check' as const, implementation: 'json-artifact.v1' as const,
      digest: installed['json-artifact.v1'],
      parameters: { checkId: 'runner-proposal-json', path: RUNNER_PROPOSAL_PATH, required: [...RUNNER_PROPOSAL_REQUIRED_FIELDS], equals: { schema_version: 1 } },
      allowedEvidenceLevels: ['local_execution'],
    },
    {
      id: 'runner-candidate-validation', kind: 'check' as const, implementation: 'gate.v1' as const,
      digest: installed['gate.v1'],
      parameters: { checkId: 'runner-candidate-validation', endpointRef: options.gateEndpoint.id, gateId: 'runner-candidate-validation' },
      allowedEvidenceLevels: ['external_service'],
    },
  ];
  const noChangeChecks = [
    {
      id: 'runner-no-change', kind: 'check' as const, implementation: 'no-change.v1' as const,
      digest: installed['no-change.v1'],
      parameters: { checkId: 'runner-no-change' },
      allowedEvidenceLevels: ['local_execution'],
    },
  ];
  const activeChecks = options.mode === 'candidate' ? candidateChecks : noChangeChecks;

  const registry: TrustedRegistry = {
    apiVersion: 'loopwright.dev/controller/v1alpha1' as const,
    kind: 'TrustedRegistry' as const,
    metadata: { id: registryId },
    spec: {
      version: 1 as const,
      resourceVersion,
      handlers: [
        { id: 'runner-author', kind: 'agent' as const, implementation: 'pi.agent.v1' as const, version: 1 as const, digest: installed['pi.agent.v1'], parameters: { prompt: authorPrompt, purpose: 'task' }, capabilities: ['pi'] },
        ...activeChecks.map(check => ({ id: check.id, kind: check.kind, implementation: check.implementation, version: 1 as const, digest: check.digest, parameters: check.parameters, capabilities: check.implementation === 'gate.v1' ? ['external_service', 'read_only'] : ['inert_bytes', 'read_only'] })),
        { id: 'runner-scope', kind: 'check' as const, implementation: 'scope.v1' as const, version: 1 as const, digest: installed['scope.v1'], parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'] },
        { id: 'runner-no-change-implicit', kind: 'check' as const, implementation: 'no-change.v1' as const, version: 1 as const, digest: installed['no-change.v1'], parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'] },
      ],
      roleProfiles: [{
        id: 'runner-author-role',
        selection: { provider: roleSelection.provider, model: roleSelection.model, thinking: roleSelection.thinking, api: roleSelection.api },
        tools: ['read', 'write', 'edit', 'bash'],
        context: { mode: 'estimated_guard', estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1, evidence: 'estimated', workingWindowCeiling: 98304, maxRequestBytes: 65536, serviceMargin: 32768, toolReserve: 16384, maxOutputTokens: RUNNER_BUDGETS.perCallOutputTokens },
        runtimeRef: 'runner-runtime',
        providerCredentialRef: 'runner-provider-token',
        mcp: { serverId: 'workspace', scriptDigest: runtime.localMcpScriptDigest, names: [], effects: [], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 },
      }],
      resources: [],
      runtimeProfiles: [{
        id: 'runner-runtime',
        dockerExecutable: runtimeOptions.dockerExecutable,
        dockerSocket: runtimeOptions.dockerSocket,
        identity: { sdkIntegrity: runtime.sdkIntegrity, graphDigest: runtime.graphDigest, imageDigest: runtimeOptions.imageDigest, configDigest: runtime.configDigest, profile: runtimeOptions.profile },
      }],
      credentialBindings: [
        { id: 'runner-provider-token', consumer: 'provider', destinationRef: 'github-copilot', environmentNames: ['RUNNER_PROVIDER_TOKEN'], template: '${RUNNER_PROVIDER_TOKEN}' },
        ...(options.mode === 'candidate' ? [{ id: options.gateEndpoint.signingCredentialRef, consumer: 'gate' as const, destinationRef: 'runner-gate-signing', environmentNames: ['RUNNER_GATE_SIGNING_SECRET'], template: '${RUNNER_GATE_SIGNING_SECRET}' }] : []),
        ...(publicationEndpoint === undefined ? [] : [{ id: publicationEndpoint.signingCredentialRef, consumer: 'publisher' as const, destinationRef: 'runner-publication-signing', environmentNames: ['RUNNER_PUBLICATION_SIGNING_SECRET'], template: '${RUNNER_PUBLICATION_SIGNING_SECRET}' }]),
      ],
      environmentBindings: [
        { name: 'RUNNER_PROVIDER_TOKEN', classification: 'credential', paths: ['/spec/credentials/0/template'] },
        ...(options.mode === 'candidate' ? [{ name: 'RUNNER_GATE_SIGNING_SECRET', classification: 'credential' as const, paths: ['/spec/credentials/1/template'] }] : []),
        ...(publicationEndpoint === undefined ? [] : [{ name: 'RUNNER_PUBLICATION_SIGNING_SECRET', classification: 'credential' as const, paths: ['/spec/credentials/2/template'] }]),
      ],
      gateEndpoints: options.mode === 'candidate' ? [{
        id: options.gateEndpoint.id,
        url: options.gateEndpoint.url,
        signingCredentialRef: options.gateEndpoint.signingCredentialRef,
        authCredentialRef: options.gateEndpoint.authCredentialRef ?? null,
        timeoutMs: options.gateEndpoint.timeoutMs ?? 30000,
        maxPollMs: options.gateEndpoint.maxPollMs ?? 120000,
        pollInitialMs: options.gateEndpoint.pollInitialMs ?? 200,
        pollMaxMs: options.gateEndpoint.pollMaxMs ?? 5000,
        jitter: options.gateEndpoint.jitter ?? 100,
      }] : [],
      publicationEndpoints: publicationEndpoint === undefined ? [] : [{
        id: publicationEndpoint.id,
        url: publicationEndpoint.url,
        signingCredentialRef: publicationEndpoint.signingCredentialRef,
        authCredentialRef: publicationEndpoint.authCredentialRef ?? null,
        timeoutMs: publicationEndpoint.timeoutMs ?? 30000,
      }],
    },
  };

  const registryBytes = Buffer.from(JSON.stringify(registry));
  const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');
  const checkIds = activeChecks.map(check => check.id);
  const credentials = [
    { ref: 'runner-provider-token', template: '${RUNNER_PROVIDER_TOKEN}' },
    ...(options.mode === 'candidate' ? [{ ref: options.gateEndpoint.signingCredentialRef, template: '${RUNNER_GATE_SIGNING_SECRET}' }] : []),
    ...(publicationEndpoint === undefined ? [] : [{ ref: publicationEndpoint.signingCredentialRef, template: '${RUNNER_PUBLICATION_SIGNING_SECRET}' }]),
  ];
  const task = {
    apiVersion: 'loopwright.dev/v1alpha1' as const,
    kind: 'TaskContract' as const,
    metadata: { id: 'runner-auto-sync' },
    spec: {
      goal: options.mode === 'candidate'
        ? 'Assess upstream updates, assemble the candidate patch and proposal document, and pass external candidate validation so the managed publication boundary can publish it.'
        : 'Confirm the frozen snapshot needs no change and settle the run as no change without any publication effect.',
      taskpack: 'runner-auto-sync',
      target: { repository: options.repository, baseRevision: options.baseRevision, sourceRevision: options.sourceRevision, matrix: null },
      scope: { writable: [...RUNNER_WRITABLE_PATHS], protected: [...RUNNER_PROTECTED_PATHS] },
      roles: [{ id: 'author', adapter: 'pi', provider: roleSelection.provider, model: roleSelection.model, thinking: roleSelection.thinking, tools: ['read', 'write', 'edit', 'bash'] }],
      trustedContext: { revision: resourceVersion, discovery: 'disabled' as const, resources: [] },
      budgets: {
        wallTimeMs: RUNNER_BUDGETS.wallTimeMs,
        totalTokens: RUNNER_BUDGETS.totalTokens,
        perCallOutputTokens: RUNNER_BUDGETS.perCallOutputTokens,
        maxModelCalls: RUNNER_BUDGETS.maxModelCalls,
        maxConcurrency: RUNNER_BUDGETS.maxConcurrency,
        maxFormatRepairs: RUNNER_BUDGETS.maxFormatRepairs,
        maxImplementationRepairs: RUNNER_BUDGETS.maxImplementationRepairs,
        maxTransportRetries: RUNNER_BUDGETS.maxTransportRetries,
        enforcement: { wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission', formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission' },
      },
      steps: options.mode === 'candidate'
        ? [
            { id: 'author-candidate', kind: 'agent' as const, uses: 'runner-author', roleId: 'author', dependsOn: [] },
            { id: 'runner-proposal-json', kind: 'check' as const, uses: 'runner-proposal-json', roleId: null, dependsOn: ['author-candidate'] },
            { id: 'runner-candidate-validation', kind: 'check' as const, uses: 'runner-candidate-validation', roleId: null, dependsOn: ['author-candidate', 'runner-proposal-json'] },
          ]
        : [
            { id: 'author-assessment', kind: 'agent' as const, uses: 'runner-author', roleId: 'author', dependsOn: [] },
            { id: 'runner-no-change', kind: 'check' as const, uses: 'runner-no-change', roleId: null, dependsOn: ['author-assessment'] },
          ],
      acceptance: {
        required: [...checkIds],
        checks: activeChecks.map(check => ({ id: check.id, allowedEvidenceLevels: check.allowedEvidenceLevels })),
      },
    },
  };

  const validated = validateDocument(task, 'TaskContract');
  if (!validated.ok) throw new RunnerTaskpackError('CONFIG_INVALID', `compiled task contract failed validation: ${JSON.stringify(validated.errors).slice(0, 256)}`);
  const config: ControllerConfiguration = {
    apiVersion: 'loopwright.dev/controller/v1alpha1',
    kind: 'ControllerConfig',
    metadata: { id: 'runner-auto-sync-config' },
    spec: {
      task: validated.value,
      registry: { id: registryId, digest: digestOf(registryBytes) },
      profiles: {
        roles: [{ roleId: 'author', profileRef: 'runner-author-role' }],
        steps: (options.mode === 'candidate'
          ? [
              { stepId: 'author-candidate', handlerRef: 'runner-author' },
              { stepId: 'runner-proposal-json', handlerRef: 'runner-proposal-json' },
              { stepId: 'runner-candidate-validation', handlerRef: 'runner-candidate-validation' },
            ]
          : [
              { stepId: 'author-assessment', handlerRef: 'runner-author' },
              { stepId: 'runner-no-change', handlerRef: 'runner-no-change' },
            ]),
      },
      credentials,
      controls: { drainReserveMs: 120000, maxAttempts: 3, repeatFailureLimit: 2, submission: { mode: 'artifact_or_assistant', path: null } },
      publication: publicationEnabled
        ? { mode: 'pull_request', endpointRef: publicationEndpoint!.id, targetBranch: options.targetBranch ?? 'main', headBranchPrefix: options.headBranchPrefix ?? 'loopwright-runner-', titleTemplate: options.titleTemplate ?? 'runner: sync upstream runtime support' }
        : { mode: 'disabled' },
    },
  };
  return { registry, config, registrySha256, registryBytes };
}
