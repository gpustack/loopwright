import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import {
  OVERLAY_LIMITS,
  matchesScopePattern,
  resolveOverlayLimits,
  validateDocument,
  validateScopePattern,
  type OverlayLimitsInput,
  type TaskContract,
} from '@loopwright/core';
import { installedHandlerDigests, type ControllerConfiguration, type Handler, type TrustedRegistry } from '@loopwright/controller';
import { RunnerTaskpackError } from './types.js';

/** Runner's candidate patch surface using explicit Taskpack 2.0 directory (`/**`) and exact-file syntax. */
export const RUNNER_WRITABLE_PATHS = ['pack/**', 'docs/supported-runners.md', 'docs/support-records.md', 'runtime_runner/runner.py.json', '.autosync/proposal.json'] as const;
/** Runner's default repository-level protected surface when `options.scope` is omitted. */
export const RUNNER_PROTECTED_PATHS = ['.github/**', 'tools/**', 'tests/**'] as const;
/** Neutral built-in paths that always stay write-protected regardless of custom scope configuration. */
export const RUNNER_ALWAYS_PROTECTED_PATHS = ['.git/**'] as const;
export const RUNNER_WORKFLOW_PROTECTED_PATH = '.github/workflows/**' as const;
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
  readonly thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly api?: 'anthropic-messages' | 'openai-completions' | 'openai-responses';
}

export interface RunnerRuntimeOptions {
  readonly dockerExecutable?: string;
  readonly dockerSocket?: string;
  readonly imageDigest?: string;
  /** The frozen runtime profile supports only the linux/arm64 container platform. */
  readonly profile?: 'linux/arm64';
}

export interface RunnerScopeOptions {
  readonly writable: readonly string[];
  readonly protected?: readonly string[];
}

export interface RunnerExecutionOptions {
  readonly capabilities?: {
    readonly allowWorkflowWrites?: boolean;
  };
}

export interface RunnerHostPolicy {
  readonly allowWorkflowWrites?: boolean;
  readonly policyProfile?: 'local' | 'github';
}

export interface RunnerProposalOptions {
  readonly path: string;
  readonly requiredFields?: readonly string[];
  readonly schemaVersion?: number;
}

export type RunnerLocalCheckPlan =
  | {
      readonly id: string;
      readonly implementation: 'json-artifact.v1';
      readonly parameters: {
        readonly path: string;
        readonly required: readonly string[];
        readonly equals: Readonly<Record<string, string | number | boolean | null>>;
      };
    }
  | {
      readonly id: string;
      readonly implementation: 'json-keys-guard.v1';
      readonly parameters: {
        readonly path: string;
        readonly allowedPointers: readonly string[];
      };
    }
  | {
      readonly id: string;
      readonly implementation: 'line-section-guard.v1';
      readonly parameters: {
        readonly path: string;
        readonly startMarker: string;
        readonly endMarker: string;
      };
    };

export interface CompileRunnerTaskpackOptions {
  readonly mode: 'candidate' | 'no-change';
  readonly repository: string;
  readonly baseRevision: string;
  readonly sourceRevision: string;
  readonly gateEndpoint?: RunnerGateEndpointPlan;
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
  readonly scope?: RunnerScopeOptions;
  readonly execution?: RunnerExecutionOptions;
  readonly hostPolicy?: RunnerHostPolicy;
  readonly proposal?: RunnerProposalOptions | null;
  readonly submission?: { readonly path: string | null };
  readonly limits?: { readonly overlay?: OverlayLimitsInput };
  readonly localChecks?: readonly RunnerLocalCheckPlan[];
  readonly targetMatrix?: TaskContract['spec']['target']['matrix'];
}

export interface CompiledRunnerTaskpack {
  readonly registry: TrustedRegistry;
  readonly config: ControllerConfiguration;
  readonly registrySha256: string;
  readonly registryBytes: Buffer;
}

function globSegmentsOverlap(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const dp = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let res = false;
    if (i === a.length && j === b.length) {
      res = true;
    } else if (i < a.length && a[i] === '*') {
      res = dp(i + 1, j) || (j < b.length && dp(i, j + 1));
    } else if (j < b.length && b[j] === '*') {
      res = dp(i, j + 1) || (i < a.length && dp(i + 1, j));
    } else if (i < a.length && j < b.length && (a[i] === '?' || b[j] === '?' || a[i] === b[j])) {
      res = dp(i + 1, j + 1);
    }
    memo.set(key, res);
    return res;
  };
  return dp(0, 0);
}

function scopePatternsOverlap(a: string, b: string): boolean {
  if (a === '**' || b === '**') return true;
  const aRec = a.endsWith('/**');
  const bRec = b.endsWith('/**');
  const aSegs = (aRec ? a.slice(0, -3) : a).split('/');
  const bSegs = (bRec ? b.slice(0, -3) : b).split('/');
  if (!aRec && !bRec && aSegs.length !== bSegs.length) return false;
  if (aRec && !bRec && bSegs.length < aSegs.length) return false;
  if (bRec && !aRec && aSegs.length < bSegs.length) return false;
  const minLen = Math.min(aSegs.length, bSegs.length);
  for (let i = 0; i < minLen; i++) {
    if (!globSegmentsOverlap(aSegs[i]!, bSegs[i]!)) return false;
  }
  return true;
}

function validateAndDedupeScopePatterns(patterns: readonly string[], field: 'writable' | 'protected'): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [index, entry] of patterns.entries()) {
    const checked = validateScopePattern(entry);
    if (!checked.ok) {
      throw new RunnerTaskpackError('CONFIG_INVALID', `invalid scope.${field}[${index}] pattern "${entry}": ${checked.errors[0]?.code ?? 'PATTERN_UNSUPPORTED'}`);
    }
    if (!seen.has(checked.value)) {
      seen.add(checked.value);
      out.push(checked.value);
    }
  }
  return out;
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

function controlRootCarveOutPattern(
  proposalPath: string,
  writablePatterns: readonly string[],
  protectedPatterns: readonly string[],
  mandatoryProtected: readonly string[],
): string | null {
  if (!/\.(?:json|ya?ml)$/i.test(proposalPath)) return null;
  const segments = proposalPath.split('/');
  if (segments.length < 2) return null;
  const root = segments[0]!;
  if (!root.startsWith('.') || root === '.git' || root === '.github') return null;
  const rootPattern = `${root}/**`;
  if (!protectedPatterns.includes(rootPattern)) return null;
  if (mandatoryProtected.some(pattern => {
    const matched = matchesScopePattern(pattern, proposalPath);
    return matched.ok && matched.value;
  })) {
    return null;
  }
  for (const pattern of protectedPatterns) {
    if (pattern === rootPattern) continue;
    const matched = matchesScopePattern(pattern, proposalPath);
    if (matched.ok && matched.value) return null;
  }
  if (!writablePatterns.includes(proposalPath)) return null;
  for (const entry of writablePatterns) {
    if (entry === proposalPath) continue;
    if (scopePatternsOverlap(entry, rootPattern)) return null;
  }
  return rootPattern;
}

/**
 * Compile a Runner trigger into Loopwright documents accepted by `loadTrustedConfiguration` and `compilePlan`.
 * Signing secrets appear only inside credential and environment bindings, never in handlers, steps, or the task.
 */
export async function compileRunnerTaskpack(options: CompileRunnerTaskpackOptions): Promise<CompiledRunnerTaskpack> {
  const policyProfile = options.hostPolicy?.policyProfile ?? 'github';
  if (policyProfile !== 'local' && policyProfile !== 'github') {
    throw new RunnerTaskpackError('CONFIG_INVALID', `invalid hostPolicy.policyProfile "${String(policyProfile)}"`);
  }
  const enforceGitHubWorkflowProtection = policyProfile !== 'local';
  const requestedWorkflowWrites = options.execution?.capabilities?.allowWorkflowWrites === true;
  const hostWorkflowWrites = options.hostPolicy?.allowWorkflowWrites === true;
  if (enforceGitHubWorkflowProtection && requestedWorkflowWrites && !hostWorkflowWrites) {
    throw new RunnerTaskpackError('CONFIG_INVALID', 'allowWorkflowWrites requires explicit hostPolicy.allowWorkflowWrites authorization');
  }
  const allowWorkflowWrites = requestedWorkflowWrites && hostWorkflowWrites;

  let overlayLimits: { readonly maxFiles: number; readonly maxBytes: number } | undefined;
  if (options.limits?.overlay !== undefined) {
    const resolvedOverlay = resolveOverlayLimits(options.limits.overlay);
    if (!resolvedOverlay.ok || resolvedOverlay.value.maxFiles > OVERLAY_LIMITS.maxMaxFiles) {
      throw new RunnerTaskpackError('CONFIG_INVALID', `invalid overlay limits: ${!resolvedOverlay.ok ? (resolvedOverlay.errors[0]?.code ?? 'VALUE_RANGE') : 'VALUE_RANGE'}`);
    }
    overlayLimits = { maxFiles: resolvedOverlay.value.maxFiles, maxBytes: resolvedOverlay.value.maxBytes };
  }

  const proposalConfig: RunnerProposalOptions | null = options.proposal === undefined
    ? { path: RUNNER_PROPOSAL_PATH, requiredFields: [...RUNNER_PROPOSAL_REQUIRED_FIELDS], schemaVersion: 1 }
    : options.proposal;

  const defaultWritable = proposalConfig === null
    ? RUNNER_WRITABLE_PATHS.filter(entry => entry !== RUNNER_PROPOSAL_PATH)
    : proposalConfig.path === RUNNER_PROPOSAL_PATH
      ? [...RUNNER_WRITABLE_PATHS]
      : [...RUNNER_WRITABLE_PATHS.filter(entry => entry !== RUNNER_PROPOSAL_PATH), proposalConfig.path];

  const writablePatterns = validateAndDedupeScopePatterns(
    options.scope !== undefined ? options.scope.writable : defaultWritable,
    'writable',
  );
  if (writablePatterns.length === 0) {
    throw new RunnerTaskpackError('CONFIG_INVALID', 'scope.writable must contain at least one pattern');
  }

  const mandatoryProtected = [
    ...RUNNER_ALWAYS_PROTECTED_PATHS,
    ...(enforceGitHubWorkflowProtection && !allowWorkflowWrites ? ['.github/**', RUNNER_WORKFLOW_PROTECTED_PATH] : []),
  ];
  const baseProtected = options.scope !== undefined
    ? [...(options.scope.protected ?? []), ...mandatoryProtected]
    : [
        ...(allowWorkflowWrites ? RUNNER_PROTECTED_PATHS.filter(entry => entry !== '.github/**') : RUNNER_PROTECTED_PATHS),
        ...mandatoryProtected,
      ];
  let protectedPatterns = validateAndDedupeScopePatterns(baseProtected, 'protected');

  for (const writableEntry of writablePatterns) {
    const writableLower = writableEntry.toLowerCase();
    const overlappingMandatory = mandatoryProtected.find(protectedEntry =>
      scopePatternsOverlap(writableLower, protectedEntry.toLowerCase()),
    );
    if (overlappingMandatory !== undefined) {
      throw new RunnerTaskpackError('CONFIG_INVALID', `writable path "${writableEntry}" overlaps protected path "${overlappingMandatory}"`);
    }
    if (
      enforceGitHubWorkflowProtection
      && allowWorkflowWrites
      && scopePatternsOverlap(writableLower, '.github/**')
      && writableLower !== RUNNER_WORKFLOW_PROTECTED_PATH
      && !writableLower.startsWith('.github/workflows/')
    ) {
      throw new RunnerTaskpackError(
        'CONFIG_INVALID',
        `writable path "${writableEntry}" overlaps protected non-workflow .github/** surface; only .github/workflows/** may be unlocked via allowWorkflowWrites`,
      );
    }
    if (protectedPatterns.some(protectedEntry => protectedEntry.toLowerCase() === writableLower)) {
      throw new RunnerTaskpackError('CONFIG_INVALID', `writable path "${writableEntry}" is listed in scope.protected`);
    }
  }

  if (proposalConfig !== null) {
    const proposalWritable = writablePatterns.some(pattern => {
      const matched = matchesScopePattern(pattern, proposalConfig.path);
      return matched.ok && matched.value;
    });
    if (!proposalWritable) {
      throw new RunnerTaskpackError(
        'CONFIG_INVALID',
        `proposal.path "${proposalConfig.path}" must be covered by scope.writable`,
      );
    }
    const carvedOutPattern = controlRootCarveOutPattern(
      proposalConfig.path,
      writablePatterns,
      protectedPatterns,
      mandatoryProtected,
    );
    if (carvedOutPattern !== null) {
      protectedPatterns = protectedPatterns.filter(pattern => pattern !== carvedOutPattern);
    } else {
      const proposalProtectedBy = protectedPatterns.find(pattern => {
        const matched = matchesScopePattern(pattern, proposalConfig.path);
        return matched.ok && matched.value;
      });
      if (proposalProtectedBy !== undefined) {
        throw new RunnerTaskpackError(
          'CONFIG_INVALID',
          `proposal.path "${proposalConfig.path}" is covered by protected pattern "${proposalProtectedBy}"`,
        );
      }
    }
  }

  const installed = await installedHandlerDigests();
  const runtime = await runtimeIdentity();
  const registryId = options.registryId ?? 'runner-taskpack';
  const resourceVersion = options.resourceVersion ?? 'runner-auto-sync-frozen';
  const authorPrompt = options.authorPrompt ?? (
    proposalConfig === null
      ? 'Inspect the frozen repository snapshot and produce one structured submission.'
      : 'Inspect the frozen repository snapshot and produce one structured submission with the candidate patch and proposal document.'
  );
  const publicationEnabled = options.mode === 'candidate' && options.publication?.mode !== 'disabled';
  const publicationEndpoint = publicationEnabled ? options.publicationEndpoint : undefined;
  if (publicationEnabled && publicationEndpoint === undefined) throw new RunnerTaskpackError('CONFIG_INVALID', 'candidate mode with publication requires a publication endpoint');
  const gateEndpoint = options.mode === 'candidate' ? options.gateEndpoint : undefined;
  const localChecks = options.localChecks ?? [];
  if (options.mode === 'candidate' && gateEndpoint === undefined && localChecks.length === 0) {
    throw new RunnerTaskpackError('CONFIG_INVALID', 'candidate mode requires a gate endpoint or local checks');
  }

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

  type CandidateCheckDef = {
    readonly id: string;
    readonly kind: 'check';
    readonly implementation: 'json-artifact.v1' | 'json-keys-guard.v1' | 'line-section-guard.v1' | 'gate.v1' | 'no-change.v1';
    readonly digest: { readonly algorithm: 'sha256'; readonly hex: string };
    readonly parameters: Handler['parameters'];
    readonly allowedEvidenceLevels: readonly string[];
  };

  const candidateLocalChecks: CandidateCheckDef[] = [];
  if (proposalConfig !== null) {
    candidateLocalChecks.push({
      id: 'runner-proposal-json',
      kind: 'check',
      implementation: 'json-artifact.v1',
      digest: installed['json-artifact.v1'],
      parameters: {
        checkId: 'runner-proposal-json',
        path: proposalConfig.path,
        required: [...(proposalConfig.requiredFields ?? RUNNER_PROPOSAL_REQUIRED_FIELDS)],
        equals: { schema_version: proposalConfig.schemaVersion ?? 1 },
      },
      allowedEvidenceLevels: ['local_execution'],
    });
  }
  for (const localCheck of localChecks) {
    if (candidateLocalChecks.some(existing => existing.id === localCheck.id) || (gateEndpoint !== undefined && localCheck.id === 'runner-candidate-validation')) {
      throw new RunnerTaskpackError('CONFIG_INVALID', `duplicate local check id "${localCheck.id}"`);
    }
    if (localCheck.implementation === 'json-artifact.v1') {
      candidateLocalChecks.push({
        id: localCheck.id,
        kind: 'check',
        implementation: 'json-artifact.v1',
        digest: installed['json-artifact.v1'],
        parameters: {
          checkId: localCheck.id,
          path: localCheck.parameters.path,
          required: [...localCheck.parameters.required],
          equals: { ...localCheck.parameters.equals },
        },
        allowedEvidenceLevels: ['local_execution'],
      });
    } else if (localCheck.implementation === 'json-keys-guard.v1') {
      candidateLocalChecks.push({
        id: localCheck.id,
        kind: 'check',
        implementation: 'json-keys-guard.v1',
        digest: installed['json-keys-guard.v1'],
        parameters: {
          checkId: localCheck.id,
          path: localCheck.parameters.path,
          allowedPointers: [...localCheck.parameters.allowedPointers],
        },
        allowedEvidenceLevels: ['local_execution'],
      });
    } else {
      candidateLocalChecks.push({
        id: localCheck.id,
        kind: 'check',
        implementation: 'line-section-guard.v1',
        digest: installed['line-section-guard.v1'],
        parameters: {
          checkId: localCheck.id,
          path: localCheck.parameters.path,
          startMarker: localCheck.parameters.startMarker,
          endMarker: localCheck.parameters.endMarker,
        },
        allowedEvidenceLevels: ['local_execution'],
      });
    }
  }

  const candidateChecks: CandidateCheckDef[] = [
    ...candidateLocalChecks,
    ...(gateEndpoint !== undefined
      ? [{
          id: 'runner-candidate-validation',
          kind: 'check' as const,
          implementation: 'gate.v1' as const,
          digest: installed['gate.v1'],
          parameters: { checkId: 'runner-candidate-validation', endpointRef: gateEndpoint.id, gateId: 'runner-candidate-validation' },
          allowedEvidenceLevels: ['external_service'],
        }]
      : []),
  ];
  const noChangeChecks: CandidateCheckDef[] = [
    {
      id: 'runner-no-change', kind: 'check', implementation: 'no-change.v1',
      digest: installed['no-change.v1'],
      parameters: { checkId: 'runner-no-change' },
      allowedEvidenceLevels: ['local_execution'],
    },
  ];
  const activeChecks = options.mode === 'candidate' ? candidateChecks : noChangeChecks;

  const credentialBindings = [
    { id: 'runner-provider-token', consumer: 'provider' as const, destinationRef: roleSelection.provider, environmentNames: ['RUNNER_PROVIDER_TOKEN'], template: '${RUNNER_PROVIDER_TOKEN}' },
    ...(gateEndpoint !== undefined ? [{ id: gateEndpoint.signingCredentialRef, consumer: 'gate' as const, destinationRef: 'runner-gate-signing', environmentNames: ['RUNNER_GATE_SIGNING_SECRET'], template: '${RUNNER_GATE_SIGNING_SECRET}' }] : []),
    ...(publicationEndpoint === undefined ? [] : [{ id: publicationEndpoint.signingCredentialRef, consumer: 'publisher' as const, destinationRef: 'runner-publication-signing', environmentNames: ['RUNNER_PUBLICATION_SIGNING_SECRET'], template: '${RUNNER_PUBLICATION_SIGNING_SECRET}' }]),
  ];
  const environmentBindings = [
    { name: 'RUNNER_PROVIDER_TOKEN', classification: 'credential' as const, paths: ['/spec/credentials/0/template'] },
    ...(gateEndpoint !== undefined ? [{ name: 'RUNNER_GATE_SIGNING_SECRET', classification: 'credential' as const, paths: ['/spec/credentials/1/template'] }] : []),
    ...(publicationEndpoint === undefined ? [] : [{ name: 'RUNNER_PUBLICATION_SIGNING_SECRET', classification: 'credential' as const, paths: [`/spec/credentials/${gateEndpoint !== undefined ? 2 : 1}/template`] }]),
  ];

  const registry: TrustedRegistry = {
    apiVersion: 'loopwright.dev/v1alpha1' as const,
    kind: 'TrustedRegistry' as const,
    metadata: { name: registryId },
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
      credentialBindings,
      environmentBindings,
      gateEndpoints: gateEndpoint !== undefined ? [{
        id: gateEndpoint.id,
        url: gateEndpoint.url,
        signingCredentialRef: gateEndpoint.signingCredentialRef,
        authCredentialRef: gateEndpoint.authCredentialRef ?? null,
        timeoutMs: gateEndpoint.timeoutMs ?? 30000,
        maxPollMs: gateEndpoint.maxPollMs ?? 120000,
        pollInitialMs: gateEndpoint.pollInitialMs ?? 200,
        pollMaxMs: gateEndpoint.pollMaxMs ?? 5000,
        jitter: gateEndpoint.jitter ?? 100,
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
  const credentials = credentialBindings.map(binding => ({ ref: binding.id, template: binding.template }));

  const candidateLocalIds = candidateLocalChecks.map(check => check.id);
  const candidateSteps = [
    { id: 'author-candidate', kind: 'agent' as const, uses: 'runner-author', roleId: 'author', dependsOn: [] as string[] },
    ...candidateLocalChecks.map(check => ({ id: check.id, kind: 'check' as const, uses: check.id, roleId: null, dependsOn: ['author-candidate'] })),
    ...(gateEndpoint !== undefined
      ? [{ id: 'runner-candidate-validation', kind: 'check' as const, uses: 'runner-candidate-validation', roleId: null, dependsOn: ['author-candidate', ...candidateLocalIds] }]
      : []),
  ];
  const noChangeSteps = [
    { id: 'author-assessment', kind: 'agent' as const, uses: 'runner-author', roleId: 'author', dependsOn: [] as string[] },
    { id: 'runner-no-change', kind: 'check' as const, uses: 'runner-no-change', roleId: null, dependsOn: ['author-assessment'] },
  ];
  const steps = options.mode === 'candidate' ? candidateSteps : noChangeSteps;

  const task = {
    apiVersion: 'loopwright.dev/v1alpha1' as const,
    kind: 'TaskContract' as const,
    spec: {
      goal: options.mode === 'candidate'
        ? (proposalConfig === null
            ? 'Assess upstream updates, assemble the candidate patch, and pass configured verification checks.'
            : 'Assess upstream updates, assemble the candidate patch and proposal document, and pass external candidate validation so the managed publication boundary can publish it.')
        : 'Confirm the frozen snapshot needs no change and settle the run as no change without any publication effect.',
      taskpack: 'runner-auto-sync',
      target: { repository: options.repository, baseRevision: options.baseRevision, sourceRevision: options.sourceRevision, matrix: options.targetMatrix ?? null },
      scope: { writable: [...writablePatterns], protected: [...protectedPatterns] },
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
        ...(overlayLimits !== undefined ? { overlay: overlayLimits } : {}),
      },
      steps,
      acceptance: {
        required: [...checkIds],
        checks: activeChecks.map(check => ({ id: check.id, allowedEvidenceLevels: check.allowedEvidenceLevels })),
      },
    },
  };

  const validated = validateDocument(task, 'TaskContract');
  if (!validated.ok) throw new RunnerTaskpackError('CONFIG_INVALID', `compiled task contract failed validation: ${JSON.stringify(validated.errors).slice(0, 256)}`);
  const config: ControllerConfiguration = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ControllerConfig',
    spec: {
      task: validated.value,
      registry: { name: registryId, digest: digestOf(registryBytes) },
      profiles: {
        roles: [{ roleId: 'author', profileRef: 'runner-author-role' }],
        steps: steps.map(step => ({ stepId: step.id, handlerRef: step.uses })),
      },
      credentials,
      controls: { drainReserveMs: 120000, maxAttempts: 3, repeatFailureLimit: 2, submission: { mode: 'artifact_or_assistant', path: options.submission?.path ?? null } },
      publication: publicationEnabled
        ? { mode: 'pull_request', endpointRef: publicationEndpoint!.id, targetBranch: options.targetBranch ?? 'main', headBranchPrefix: options.headBranchPrefix ?? 'loopwright-runner-', titleTemplate: options.titleTemplate ?? 'runner: sync upstream runtime support' }
        : { mode: 'disabled' },
    },
  };
  return { registry, config, registrySha256, registryBytes };
}
