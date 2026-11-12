import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import { validateDocument, type TaskContract } from '@loopwright/core';
import { CONTROLLER_API_VERSION, installedHandlerDigests, type ControllerConfiguration, type TrustedRegistry } from '@loopwright/controller';
import { effectiveProtectedPaths, normalizeRelativePath, parseTaskpackDocument, validateTaskpackManifest, type Json } from './schema.js';
import { loadPiModelsJson, resolveTaskpackModelSelection } from './models-config.js';
import { readBoundedRegularFile, serializePrettyYaml } from './yaml.js';
import {
  AUTHORIZED_ASSOCIATIONS, GitHubAppError, TASKPACK_MANIFEST_BYTES,
  type CompiledTaskpack, type HostGateEndpointPlan, type HostTaskpackBindings, type ParsedCommentCommand,
  type PiModelSelection, type TaskpackCommentCommand, type TaskpackIntakeInput, type TaskpackIntakeOutcome,
  type TaskpackManifest, type TaskpackRunDiagnostic,
} from './types.js';

/** Default controller budgets for host bindings that do not pin their own (mirrors the runner research stage). */
export const DEFAULT_HOST_BUDGETS: TaskContract['spec']['budgets'] = Object.freeze({
  wallTimeMs: 3_300_000, totalTokens: 20_000_000, perCallOutputTokens: 1024, maxModelCalls: 12, maxConcurrency: 1,
  maxFormatRepairs: 2, maxImplementationRepairs: 2, maxTransportRetries: 2,
  enforcement: Object.freeze({
    wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission',
    formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission',
  }),
});

/** Guidance bounds mirroring the committed @loopwright/taskpack-runner intake constants. */
export const GUIDANCE_MAX_LINES = 40;
export const GUIDANCE_MAX_BYTES = 2048;
export const GUIDANCE_SENTINEL = /=== .*? ===/;
export const GUIDANCE_CONTRACT_PREFIXES = ['REQUIRED:', 'NEVER:'] as const;
export const DIAGNOSTIC_LOG_LIMIT = 4000;
export const ACTIONS_RUN_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([0-9]+)(?:\/job\/([0-9]+))?\/?$/;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DRAIN_RESERVE_MS = 120_000;

function manifestInvalid(message: string, path: string | null): never {
  throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', message, path);
}

function bindingInvalid(message: string): never {
  throw new GitHubAppError('TASKPACK_HOST_BINDING_INVALID', message);
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate a `.loopwright/taskpack.yaml` (or `.yml` / `.json`) manifest, either from a repository file
 * (bounded `O_NOFOLLOW` read, symlinks and `..` traversal refused) or from in-memory bytes for pure callers.
 */
export async function loadDeclarativeTaskpack(input: { manifestPath: string; repositoryRoot?: string } | { bytes: Uint8Array; format: 'json' | 'yaml' }): Promise<TaskpackManifest> {
  if ('bytes' in input) {
    return validateTaskpackManifest(parseTaskpackDocument(input.bytes, input.format));
  }
  const { manifestPath, repositoryRoot } = input;
  const segments = manifestPath.split(/[\\/]/);
  if (manifestPath.length === 0 || segments.includes('..')) manifestInvalid('manifest path must not contain .. traversal', '/');
  const resolvedRoot = repositoryRoot === undefined ? undefined : resolve(repositoryRoot);
  let full = resolve(manifestPath);
  if (resolvedRoot !== undefined) full = isAbsolute(manifestPath) ? resolve(manifestPath) : join(resolvedRoot, manifestPath);
  if (resolvedRoot !== undefined) {
    let realRoot: string, realFull: string;
    try {
      realRoot = await realpath(resolvedRoot);
      realFull = await realpath(full);
    } catch {
      manifestInvalid('manifest or repository root does not exist', '/');
    }
    if (realFull !== realRoot && !realFull.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
      manifestInvalid('manifest escapes the repository root', '/');
    }
  }
  const format = extname(full).toLowerCase();
  if (format !== '.yaml' && format !== '.yml' && format !== '.json') manifestInvalid('manifest extension must be .yaml, .yml, or .json', '/');
  const bytes = await readBoundedRegularFile(full, TASKPACK_MANIFEST_BYTES, message => manifestInvalid(message, '/'));
  return validateTaskpackManifest(parseTaskpackDocument(bytes, format === '.json' ? 'json' : 'yaml'));
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

interface RuntimeIdentity {
  readonly sdkIntegrity: string;
  readonly graphDigest: { readonly algorithm: 'sha256'; readonly hex: string };
  readonly configDigest: { readonly algorithm: 'sha256'; readonly hex: string };
  readonly localMcpScriptDigest: { readonly algorithm: 'sha256'; readonly hex: string };
}

async function runtimeIdentity(): Promise<RuntimeIdentity> {
  const described = await describePiAdapterFiles();
  if (!described.ok) throw new GitHubAppError('TASKPACK_HOST_BINDING_INVALID', `pi adapter files could not be described: ${described.error.code}`);
  const files = described.value;
  const graphDigest = await readFile(fileURLToPath(new URL('../../../package-lock.json', import.meta.resolve('@loopwright/agent-pi'))));
  const digest = (bytes: Buffer) => ({ algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') });
  return {
    sdkIntegrity: files.sdkIntegrity,
    graphDigest: digest(graphDigest),
    configDigest: files.restrictionDigest,
    localMcpScriptDigest: files.localMcpScriptDigest,
  };
}

function requireEnvName(value: string | undefined, what: string): string {
  if (value === undefined || !ENV_NAME_PATTERN.test(value)) bindingInvalid(`${what} credential environment name must match [A-Z][A-Z0-9_]*`);
  return value;
}

/**
 * Compile a validated manifest with trusted host bindings into registry/config documents accepted by
 * `validateDocument`, `loadTrustedConfiguration`, and `compilePlan`. Signing secrets appear only inside
 * credential and environment bindings as `${NAME}` templates.
 */
export async function compileDeclarativeTaskpack(manifest: TaskpackManifest, bindings: HostTaskpackBindings): Promise<CompiledTaskpack> {
  const mode = bindings.mode;
  const candidate = mode === 'candidate';
  const resourceVersion = bindings.resourceVersion ?? `taskpack-${manifest.metadata.name}`;
  if (!REVISION_PATTERN.test(resourceVersion)) bindingInvalid('resourceVersion is not a valid revision identifier');
  if (bindings.budgets.wallTimeMs <= DRAIN_RESERVE_MS) bindingInvalid(`budget wallTimeMs must exceed the ${DRAIN_RESERVE_MS}ms drain reserve`);
  const modelsConfig = bindings.modelsJsonPath === undefined ? undefined : await loadPiModelsJson(bindings.modelsJsonPath);
  const { selection } = resolveTaskpackModelSelection(manifest, bindings, modelsConfig);
  const providerEnv = requireEnvName(bindings.credentialEnvMap.provider, 'provider');
  const runtime = await runtimeIdentity();
  const installed = await installedHandlerDigests();
  const authorPrompt = bindings.authorPrompt ?? 'Inspect the repository snapshot and produce one structured submission with the candidate patch and proposal document.';

  const publicationEnabled = candidate && manifest.spec.publication.mode === 'pull_request';
  const publicationEndpoint = publicationEnabled ? bindings.publicationEndpoint : undefined;
  if (publicationEnabled && (publicationEndpoint === undefined || publicationEndpoint === null)) {
    bindingInvalid('candidate mode with pull_request publication requires a publicationEndpoint host binding');
  }
  const gatePlans = candidate ? [...(bindings.gateEndpoints ?? [])] : [];
  const gates = candidate ? manifest.spec.verification.externalGates : [];
  const gateSigningRefs = new Set(gatePlans.map(plan => plan.signingCredentialRef));
  if (gates.length > 0) {
    if (gatePlans.length === 0) bindingInvalid('external gates require gateEndpoints host bindings');
    if (gateSigningRefs.size !== 1) bindingInvalid('all gate endpoints must share one signingCredentialRef');
  }
  const gateEnv = gates.length > 0 ? requireEnvName(bindings.credentialEnvMap.gate, 'gate') : null;
  const publicationEnv = publicationEnabled ? requireEnvName(bindings.credentialEnvMap.publication, 'publication') : null;

  interface ActiveCheck {
    readonly id: string;
    readonly implementation: 'json-artifact.v1' | 'scope.v1' | 'no-change.v1' | 'gate.v1';
    readonly parameters: Record<string, unknown>;
    readonly allowedEvidenceLevels: readonly ('local_execution' | 'external_service')[];
  }
  const activeChecks: ActiveCheck[] = [];
  if (candidate) {
    for (const declared of manifest.spec.verification.localChecks) {
      const parameters: Record<string, unknown> = { checkId: declared.id };
      if (declared.implementation === 'json-artifact.v1') {
        parameters['path'] = manifest.spec.proposal.path;
        parameters['required'] = [...manifest.spec.proposal.requiredFields];
        parameters['equals'] = { schema_version: manifest.spec.proposal.schemaVersion };
      }
      Object.assign(parameters, declared.parameters ?? {});
      activeChecks.push({
        id: declared.id, implementation: declared.implementation, parameters,
        allowedEvidenceLevels: ['local_execution'],
      });
    }
    for (const gate of gates) {
      const plan = gatePlans.find(item => item.id === gate.endpointId);
      if (plan === undefined) bindingInvalid(`external gate "${gate.id}" references unknown endpoint "${gate.endpointId}"`);
      activeChecks.push({
        id: gate.id, implementation: 'gate.v1',
        parameters: { checkId: gate.id, endpointRef: gate.endpointId, gateId: gate.gateId },
        allowedEvidenceLevels: ['external_service'],
      });
    }
  }
  // The frozen compile capability accepts only a null task matrix; host targetMatrix stays intake metadata.
  void bindings.targetMatrix;

  const authorStepId = candidate ? 'author-candidate' : 'author-assessment';
  const steps: { id: string; kind: 'agent' | 'check'; uses: string; roleId: string | null; dependsOn: string[] }[] = [
    { id: authorStepId, kind: 'agent', uses: 'taskpack-author', roleId: 'author', dependsOn: [] },
  ];
  for (const [index, check] of activeChecks.entries()) {
    steps.push({ id: check.id, kind: 'check', uses: check.id, roleId: null, dependsOn: index === 0 ? [authorStepId] : [activeChecks[index - 1]!.id] });
  }
  if (candidate) {
    const required = activeChecks.filter((_, index) => index < manifest.spec.verification.localChecks.length || gates[index - manifest.spec.verification.localChecks.length]?.required === true).map(check => check.id);
    if (required.length === 0) bindingInvalid('candidate mode requires at least one required check');
    return assemble({ manifest, bindings, selection, mode: 'candidate', resourceVersion, authorPrompt, runtime, installed, providerEnv, gateEnv, publicationEnv, activeChecks, steps, required: [...required], authorStepId, gatePlans, publicationEndpoint });
  }
  const noChangeCheck: ActiveCheck = {
    id: 'taskpack-no-change', implementation: 'no-change.v1',
    parameters: { checkId: 'taskpack-no-change' }, allowedEvidenceLevels: ['local_execution'],
  };
  const noChangeSteps = [
    { id: authorStepId, kind: 'agent' as const, uses: 'taskpack-author', roleId: 'author' as const, dependsOn: [] as string[] },
    { id: noChangeCheck.id, kind: 'check' as const, uses: noChangeCheck.id, roleId: null, dependsOn: [authorStepId] },
  ];
  return assemble({
    manifest, bindings, selection, mode: 'no-change', resourceVersion, authorPrompt, runtime, installed, providerEnv,
    gateEnv: null, publicationEnv: null, activeChecks: [noChangeCheck], steps: noChangeSteps,
    required: [noChangeCheck.id], authorStepId, gatePlans: [], publicationEndpoint: undefined,
  });
}

interface AssembleInput {
  readonly manifest: TaskpackManifest;
  readonly bindings: HostTaskpackBindings;
  readonly selection: PiModelSelection;
  readonly mode: 'candidate' | 'no-change';
  readonly resourceVersion: string;
  readonly authorPrompt: string;
  readonly runtime: RuntimeIdentity;
  readonly installed: Readonly<Record<string, { algorithm: 'sha256'; hex: string }>>;
  readonly providerEnv: string;
  readonly gateEnv: string | null;
  readonly publicationEnv: string | null;
  readonly activeChecks: readonly { readonly id: string; readonly implementation: string; readonly parameters: Record<string, unknown>; readonly allowedEvidenceLevels: readonly ('local_execution' | 'external_service')[] }[];
  readonly steps: readonly { id: string; kind: 'agent' | 'check'; uses: string; roleId: string | null; dependsOn: string[] }[];
  readonly required: readonly string[];
  readonly authorStepId: string;
  readonly gatePlans: readonly HostGateEndpointPlan[];
  readonly publicationEndpoint: HostTaskpackBindings['publicationEndpoint'];
}

function assemble(input: AssembleInput): CompiledTaskpack {
  const { manifest, bindings, selection, runtime, installed } = input;
  const candidate = input.mode === 'candidate';
  const digestOf = (bytes: Buffer) => ({ algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') });
  const registryName = `taskpack-${manifest.metadata.name}`;
  const gateEndpoints = input.gatePlans.map(plan => ({
    id: plan.id, url: plan.url, signingCredentialRef: plan.signingCredentialRef,
    authCredentialRef: plan.authCredentialRef ?? null,
    timeoutMs: plan.timeoutMs ?? 30_000, maxPollMs: plan.maxPollMs ?? 120_000,
    pollInitialMs: plan.pollInitialMs ?? 200, pollMaxMs: plan.pollMaxMs ?? 5_000, jitter: plan.jitter ?? 100,
  }));
  const publicationEndpoints = input.publicationEndpoint === undefined || input.publicationEndpoint === null ? [] : [{
    id: input.publicationEndpoint.id, url: input.publicationEndpoint.url,
    signingCredentialRef: input.publicationEndpoint.signingCredentialRef,
    authCredentialRef: input.publicationEndpoint.authCredentialRef ?? null,
    timeoutMs: input.publicationEndpoint.timeoutMs ?? 30_000,
  }];
  const credentialBindings: { id: string; consumer: 'provider' | 'gate' | 'publisher'; destinationRef: string; environmentNames: readonly string[]; template: string }[] = [
    { id: 'taskpack-provider-token', consumer: 'provider', destinationRef: selection.provider, environmentNames: [input.providerEnv], template: `\${${input.providerEnv}}` },
  ];
  const gateBindingId = input.gateEnv === null ? null : [...new Set(input.gatePlans.map(plan => plan.signingCredentialRef))][0] ?? 'taskpack-gate-signing';
  if (input.gateEnv !== null && gateBindingId !== null) {
    credentialBindings.push({ id: gateBindingId, consumer: 'gate', destinationRef: 'taskpack-gate-signing', environmentNames: [input.gateEnv], template: `\${${input.gateEnv}}` });
  }
  if (input.publicationEnv !== null && input.publicationEndpoint !== undefined && input.publicationEndpoint !== null) {
    credentialBindings.push({
      id: input.publicationEndpoint.signingCredentialRef, consumer: 'publisher', destinationRef: 'taskpack-publication-signing',
      environmentNames: [input.publicationEnv], template: `\${${input.publicationEnv}}`,
    });
  }
  const environmentBindings = credentialBindings.map((binding, index) => ({
    name: binding.environmentNames[0]!, classification: 'credential' as const, paths: [`/spec/credentials/${index}/template`],
  }));
  const handlers = [
    {
      id: 'taskpack-author', kind: 'agent' as const, implementation: 'pi.agent.v1' as const, version: 1 as const,
      digest: installed['pi.agent.v1']!, parameters: { prompt: input.authorPrompt, purpose: 'task' }, capabilities: ['pi'],
    },
    ...input.activeChecks.map(check => ({
      id: check.id, kind: 'check' as const, implementation: check.implementation as 'json-artifact.v1' | 'scope.v1' | 'no-change.v1' | 'gate.v1',
      version: 1 as const, digest: installed[check.implementation]!, parameters: check.parameters as Readonly<Record<string, Json>>,
      capabilities: check.implementation === 'gate.v1' ? ['external_service', 'read_only'] : ['inert_bytes', 'read_only'],
    })),
    {
      id: 'scope', kind: 'check' as const, implementation: 'scope.v1' as const, version: 1 as const,
      digest: installed['scope.v1']!, parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'],
    },
    {
      id: 'no-change', kind: 'check' as const, implementation: 'no-change.v1' as const, version: 1 as const,
      digest: installed['no-change.v1']!, parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'],
    },
  ];
  const registry: TrustedRegistry = {
    apiVersion: CONTROLLER_API_VERSION, kind: 'TrustedRegistry', metadata: { name: registryName },
    spec: {
      version: 1 as const, resourceVersion: input.resourceVersion, handlers,
      roleProfiles: [{
        id: 'taskpack-author-role',
        selection,
        tools: ['read', 'write', 'edit', 'bash'],
        context: {
          mode: 'estimated_guard' as const, estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1,
          evidence: 'estimated' as const, workingWindowCeiling: 98_304, maxRequestBytes: 65_536, serviceMargin: 32_768,
          toolReserve: 16_384, maxOutputTokens: bindings.budgets.perCallOutputTokens,
        },
        runtimeRef: 'taskpack-runtime', providerCredentialRef: 'taskpack-provider-token',
        mcp: { serverId: 'workspace', scriptDigest: runtime.localMcpScriptDigest, names: [], effects: [], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 },
      }],
      resources: [],
      runtimeProfiles: [{
        id: 'taskpack-runtime',
        dockerExecutable: bindings.runtimeOptions?.dockerExecutable ?? '/usr/local/bin/docker',
        dockerSocket: bindings.runtimeOptions?.dockerSocket ?? '/var/run/docker.sock',
        identity: {
          sdkIntegrity: runtime.sdkIntegrity, graphDigest: runtime.graphDigest,
          imageDigest: bindings.runtimeOptions?.imageDigest ?? `sha256:${'a'.repeat(64)}`,
          configDigest: runtime.configDigest, profile: bindings.runtimeOptions?.profile ?? 'linux/arm64',
        },
      }],
      credentialBindings, environmentBindings, gateEndpoints, publicationEndpoints,
    },
  };
  const registryBytes = Buffer.from(serializePrettyYaml(registry), 'utf8');
  const registrySha256 = createHash('sha256').update(registryBytes).digest('hex');
  const task = {
    apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'TaskContract' as const,
    spec: {
      goal: candidate ? manifest.spec.goal.candidate : manifest.spec.goal.noChange,
      taskpack: manifest.metadata.name,
      target: { repository: bindings.repository, baseRevision: bindings.baseRevision, sourceRevision: bindings.sourceRevision, matrix: null },
      scope: { writable: [...manifest.spec.scope.writable], protected: [...effectiveProtectedPaths(manifest.spec.scope.protected)] },
      roles: [{
        id: 'author', adapter: 'pi', provider: selection.provider, model: selection.model,
        thinking: selection.thinking, tools: ['read', 'write', 'edit', 'bash'],
      }],
      trustedContext: { revision: input.resourceVersion, discovery: 'disabled' as const, resources: [] },
      budgets: bindings.budgets,
      steps: input.steps.map(step => ({ ...step, dependsOn: [...step.dependsOn] })),
      acceptance: {
        required: [...input.required],
        checks: input.activeChecks.map(check => ({ id: check.id, allowedEvidenceLevels: [...check.allowedEvidenceLevels] })),
      },
    },
  };
  const validated = validateDocument(task, 'TaskContract');
  if (!validated.ok) {
    throw new GitHubAppError('TASKPACK_HOST_BINDING_INVALID', `compiled task contract failed validation: ${JSON.stringify(validated.errors).slice(0, 256)}`);
  }
  const config: ControllerConfiguration = {
    apiVersion: CONTROLLER_API_VERSION, kind: 'ControllerConfig',
    spec: {
      task: validated.value, registry: { name: registryName, digest: digestOf(registryBytes) },
      profiles: {
        roles: [{ roleId: 'author', profileRef: 'taskpack-author-role' }],
        steps: input.steps.map(step => ({ stepId: step.id, handlerRef: step.uses })),
      },
      credentials: credentialBindings.map(binding => ({ ref: binding.id, template: binding.template })),
      controls: { drainReserveMs: DRAIN_RESERVE_MS, maxAttempts: 3, repeatFailureLimit: 2, submission: { mode: 'artifact_or_assistant', path: null } },
      publication: candidate && publicationEndpoints.length > 0
        ? {
          mode: 'pull_request', endpointRef: publicationEndpoints[0]!.id,
          targetBranch: manifest.spec.publication.targetBranch, headBranchPrefix: manifest.spec.publication.headBranchPrefix,
          titleTemplate: manifest.spec.publication.titleTemplate,
        }
        : { mode: 'disabled' as const },
    },
  };
  return { registry, config, registrySha256, registryBytes };
}

// ---------------------------------------------------------------------------
// Generic repository-agnostic intake
// ---------------------------------------------------------------------------

/** Strict guidance bounds: line count, UTF-8 byte budget, prompt sentinels, and contract overrides. */
export function validateCommentGuidance(body: string): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  const lines = body.split('\n');
  if (lines.length > GUIDANCE_MAX_LINES) return { ok: false, detail: `guidance exceeds ${GUIDANCE_MAX_LINES} lines (${lines.length})` };
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > GUIDANCE_MAX_BYTES) return { ok: false, detail: `guidance exceeds ${GUIDANCE_MAX_BYTES} bytes (${bytes})` };
  if (GUIDANCE_SENTINEL.test(body)) return { ok: false, detail: 'guidance contains a prompt sentinel' };
  const prefix = lines.find(line => (GUIDANCE_CONTRACT_PREFIXES as readonly string[]).some(candidate => line.startsWith(candidate)));
  if (prefix !== undefined) return { ok: false, detail: 'guidance contains a contract override prefix' };
  return { ok: true };
}

/** Only established collaborators (or explicitly allowlisted operators) may command a revision. */
export function authorizeRepositoryActor(authorAssociation: string, login: string, allowlist?: readonly string[]): boolean {
  return (AUTHORIZED_ASSOCIATIONS as readonly string[]).includes(authorAssociation) || (allowlist ?? []).includes(login);
}

/** Parse a same-repository GitHub Actions run URL; cross-repository or malformed URLs are rejected. */
export function parseActionsRunUrl(url: string, identityRepository: string):
  | { readonly ok: true; readonly repository: string; readonly runId: string; readonly jobId: string | null }
  | { readonly ok: false; readonly reason: 'invalid_run_url' | 'unknown_repository_url'; readonly detail: string } {
  const match = ACTIONS_RUN_URL_PATTERN.exec(url.trim());
  if (match === null) return { ok: false, reason: 'invalid_run_url', detail: 'url is not a GitHub Actions run or job URL' };
  const repository = match[1]!, runId = match[2]!, jobId = match[3] ?? null;
  if (repository !== identityRepository) return { ok: false, reason: 'unknown_repository_url', detail: `url repository ${repository} differs from managed identity ${identityRepository}` };
  return { ok: true, repository, runId, jobId };
}

/** Keep the diagnostic tail (last 4000 characters), strip every sentinel, and re-bound. */
export function boundDiagnosticLog(text: string): { readonly jobLogText: string; readonly truncated: boolean } {
  const tail = text.length > DIAGNOSTIC_LOG_LIMIT ? text.slice(-DIAGNOSTIC_LOG_LIMIT) : text;
  const globalSentinel = new RegExp(GUIDANCE_SENTINEL.source, 'g');
  const sanitized = tail.replace(globalSentinel, '[sentinel removed]');
  const bounded = sanitized.length > DIAGNOSTIC_LOG_LIMIT ? sanitized.slice(-DIAGNOSTIC_LOG_LIMIT) : sanitized;
  return { jobLogText: bounded, truncated: text.length > DIAGNOSTIC_LOG_LIMIT };
}

/** Parse the first comment line as `<prefix> <command>`; anything else returns null. */
export function parseCommentCommand(body: string, prefixes: readonly string[], commands: readonly TaskpackCommentCommand[]): ParsedCommentCommand | null {
  const firstLine = body.split('\n')[0]?.trimEnd() ?? '';
  for (const prefix of prefixes) {
    if (!firstLine.startsWith(`${prefix} `)) continue;
    const remainder = firstLine.slice(prefix.length).trim();
    const command = remainder.split(/\s+/)[0] ?? '';
    if (!(commands as readonly string[]).includes(command)) return null;
    return { command: command as TaskpackCommentCommand, guidance: body.split('\n').slice(1).join('\n') };
  }
  return null;
}

/** Pure deterministic intake evaluation over declarative upstream records; no Python bridge. */
export function prepareTaskpackIntake(input: TaskpackIntakeInput): TaskpackIntakeOutcome {
  if (input.mode === 'revise') {
    if (!authorizeRepositoryActor(input.authorAssociation, input.actorLogin, input.operatorAllowlist)) {
      return { kind: 'revise', disposition: 'blocked', reason: 'unauthorized_actor', detail: `actor ${input.actorLogin} lacks write access (${input.authorAssociation})` };
    }
    const guidance = validateCommentGuidance(input.guidance);
    if (!guidance.ok) return { kind: 'revise', disposition: 'blocked', reason: 'invalid_guidance', detail: guidance.detail };
    return { kind: 'revise', disposition: 'ready', command: input.command };
  }
  if (input.mode === 'run-url') {
    const parsed = parseActionsRunUrl(input.url, input.identityRepository);
    if (!parsed.ok) return { kind: 'run-url', disposition: 'blocked', reason: parsed.reason, detail: parsed.detail };
    const bounded = boundDiagnosticLog(input.jobLogText);
    return {
      kind: 'run-url', disposition: 'ready',
      diagnostic: { url: input.url, repository: parsed.repository, runId: parsed.runId, jobId: parsed.jobId, jobLogText: bounded.jobLogText, truncated: bounded.truncated } satisfies TaskpackRunDiagnostic,
    };
  }
  if (input.mode === 'status') {
    return { kind: 'status', disposition: 'ready', summary: `status query admitted for ${input.tenant.repositoryFullName}/${input.tenant.taskpackId}` };
  }
  const updates = input.records.filter(record => record.status === 'available');
  const failures = input.records
    .filter(record => record.status === 'failed' || record.status === 'blocked')
    .map(record => ({ upstreamId: record.upstreamId, error: record.reason ?? 'acquisition failed' }));
  if (updates.length === 0 && failures.length > 0) {
    return { kind: 'discover', disposition: 'blocked', reason: 'upstream_unavailable', failures };
  }
  if (updates.length === 0 || input.managedPrMatchesDiscoveredState === true) {
    return {
      kind: 'discover', disposition: 'no_change',
      reason: updates.length === 0 ? 'no subscription reports an available update' : 'an open managed pull request already matches the discovered state',
    };
  }
  return { kind: 'discover', disposition: 'ready', baseRevision: input.baseRevision, updates, targetMatrix: input.targetMatrix ?? null };
}

/** Re-exported so Action and service callers need only this module for path normalization. */
export { normalizeRelativePath };
