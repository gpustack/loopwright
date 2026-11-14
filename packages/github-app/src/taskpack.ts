import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import { resolveCatalogModel } from '@loopwright/agent-pi/catalog';
import { validateDocument, type TaskContract } from '@loopwright/core';
import { CONTROLLER_API_VERSION, installedHandlerDigests, type ControllerConfiguration, type TrustedRegistry } from '@loopwright/controller';
import {
  collectMcpReferencedEnvNames, effectiveProtectedPaths, normalizeRelativePath, parseTaskpackDocument,
  pathCoveredBy, validateTaskpackLimitsDeclaration, validateTaskpackManifest, type Json,
} from './schema.js';
import { loadPiModelsJson, resolveTaskpackModelCandidates, resolveTaskpackModelSelection } from './models-config.js';
import { readBoundedRegularFile, serializePrettyYaml } from './yaml.js';
import {
  AUTHORIZED_ASSOCIATIONS, DEFAULT_LOCAL_COMMAND_GATE_ENV, GitHubAppError, LOCAL_COMMAND_GATE_ENDPOINT_ID, TASKPACK_MANIFEST_BYTES,
  type CompiledInstructionResource, type CompiledLocalCommandGate, type CompiledTaskpack, type HostGateEndpointPlan,
  type HostTaskpackBindings, type ParsedCommentCommand, type PiModelSelection, type TaskpackCommentCommand,
  type TaskpackIntakeInput, type TaskpackIntakeOutcome, type TaskpackLimitsDeclaration, type TaskpackManifest,
  type TaskpackRunDiagnostic,
} from './types.js';

/** Default controller budgets for host bindings that do not pin their own. */
export const DEFAULT_HOST_BUDGETS: TaskContract['spec']['budgets'] = Object.freeze({
  wallTimeMs: 3_600_000, totalTokens: 20_000_000, perCallOutputTokens: 32_768, maxModelCalls: 256, maxConcurrency: 1,
  maxFormatRepairs: 6, maxImplementationRepairs: 32, maxTransportRetries: 3,
  enforcement: Object.freeze({
    wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission',
    formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission',
  }),
});

/** Default author prompt header declaring the required submission.v1 final assistant response contract. */
export const DEFAULT_AUTHOR_PROMPT_HEAD = [
  'Inspect the repository snapshot and produce one structured submission with the candidate patch and proposal document.',
  'After inspecting/updating the candidate workspace, your final assistant message MUST be ONLY one raw UTF-8 JSON object (no surrounding prose, no Markdown summary, and no bare ``` code fence) matching:',
  '{"version":1,"status":"completed"|"no_change"|"failed"|"blocked","checks":[],"reason":"<single-line printable summary or null>"}',
  'where "checks" is [] (host verifiers run independently after your turn) and "reason" is either null or a non-empty single-line printable string (1..4096 chars, no \\n, \\r, \\t, or control characters).',
].join(' ');

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
export const INSTRUCTION_MAX_AGGREGATE_BYTES = 262_144;
const COMMAND_SCRIPT_MAX_BYTES = 262_144;

export function parseEnvAndInputLimitsOverride(env: NodeJS.ProcessEnv): TaskpackLimitsDeclaration {
  const raw: Record<string, number> = {};
  const parseEnvInt = (envKey: string): number | undefined => {
    const val = env[envKey]?.trim();
    if (val === undefined || val === '') return undefined;
    if (!/^-?\d+$/.test(val)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `invalid integer in ${envKey}: "${val}"`, envKey);
    }
    const parsed = Number(val);
    if (!Number.isSafeInteger(parsed)) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `integer out of range in ${envKey}: "${val}"`, envKey);
    }
    return parsed;
  };
  const pick = (targetField: string, ...envKeys: string[]): void => {
    for (const key of envKeys) {
      const val = parseEnvInt(key);
      if (val !== undefined) {
        raw[targetField] = val;
        return;
      }
    }
  };
  // Precedence: INPUT_* > LOOPWRIGHT_*
  const inputWallSec = parseEnvInt('INPUT_WALL-TIME-SECONDS');
  const envWallMs = parseEnvInt('LOOPWRIGHT_WALL_TIME_MS');
  const envWallSec = parseEnvInt('LOOPWRIGHT_WALL_TIME_SECONDS');
  if (inputWallSec !== undefined) raw['wallTimeSeconds'] = inputWallSec;
  else if (envWallMs !== undefined) raw['wallTimeMs'] = envWallMs;
  else if (envWallSec !== undefined) raw['wallTimeSeconds'] = envWallSec;

  pick('totalTokens', 'INPUT_TOTAL-TOKENS', 'LOOPWRIGHT_TOTAL_TOKENS');
  pick('contextWindow', 'INPUT_CONTEXT-WINDOW', 'LOOPWRIGHT_CONTEXT_WINDOW');
  pick('maxOutputTokens', 'INPUT_MAX-OUTPUT-TOKENS', 'LOOPWRIGHT_MAX_OUTPUT_TOKENS', 'LOOPWRIGHT_PER_CALL_OUTPUT_TOKENS');
  pick('maxModelCalls', 'INPUT_MAX-MODEL-CALLS', 'LOOPWRIGHT_MAX_MODEL_CALLS');
  pick('maxAttempts', 'INPUT_MAX-ATTEMPTS', 'LOOPWRIGHT_MAX_ATTEMPTS');
  pick('maxFormatRepairs', 'LOOPWRIGHT_MAX_FORMAT_REPAIRS');
  pick('maxImplementationRepairs', 'LOOPWRIGHT_MAX_IMPLEMENTATION_REPAIRS');
  pick('maxTransportRetries', 'LOOPWRIGHT_MAX_TRANSPORT_RETRIES');

  const inputToolSec = parseEnvInt('INPUT_TOOL-TIMEOUT-SECONDS');
  const envToolWallMs = parseEnvInt('LOOPWRIGHT_TOOL_WALL_MS');
  const envToolSec = parseEnvInt('LOOPWRIGHT_TOOL_TIMEOUT_SECONDS');
  if (inputToolSec !== undefined) raw['toolTimeoutSeconds'] = inputToolSec;
  else if (envToolWallMs !== undefined) raw['toolWallMs'] = envToolWallMs;
  else if (envToolSec !== undefined) raw['toolTimeoutSeconds'] = envToolSec;

  pick('commandTimeoutSeconds', 'INPUT_COMMAND-TIMEOUT-SECONDS', 'LOOPWRIGHT_COMMAND_TIMEOUT_SECONDS');
  pick('responseBytes', 'LOOPWRIGHT_RESPONSE_BYTES');
  pick('toolResultBytes', 'LOOPWRIGHT_TOOL_RESULT_BYTES');
  pick('toolArgsBytes', 'LOOPWRIGHT_TOOL_ARGS_BYTES');
  pick('promptBytes', 'LOOPWRIGHT_PROMPT_BYTES');
  pick('maxRequestBytes', 'LOOPWRIGHT_MAX_REQUEST_BYTES');
  pick('workingWindowBytes', 'LOOPWRIGHT_WORKING_WINDOW_BYTES');
  pick('fileBytes', 'LOOPWRIGHT_FILE_BYTES');
  pick('sessionBytes', 'LOOPWRIGHT_SESSION_BYTES');
  pick('candidateEntries', 'LOOPWRIGHT_CANDIDATE_ENTRIES');

  if (Object.keys(raw).length === 0) return Object.freeze({});
  try {
    return validateTaskpackLimitsDeclaration(raw, '/env/limits');
  } catch (error) {
    if (error instanceof GitHubAppError) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', error.message, error.path);
    }
    throw error;
  }
}

export function mergeTaskpackLimits(
  base: TaskpackLimitsDeclaration | undefined,
  override: TaskpackLimitsDeclaration | undefined,
): TaskpackLimitsDeclaration {
  if (!base && !override) return Object.freeze({});
  const out: Record<string, number> = {};
  if (base) {
    for (const [k, v] of Object.entries(base)) {
      if (typeof v === 'number') out[k] = v;
    }
  }
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      if (typeof v === 'number') {
        out[k] = v;
        if (k === 'wallTimeSeconds') delete out['wallTimeMs'];
        if (k === 'wallTimeMs') delete out['wallTimeSeconds'];
        if (k === 'maxOutputTokens') delete out['perCallOutputTokens'];
        if (k === 'perCallOutputTokens') delete out['maxOutputTokens'];
        if (k === 'toolTimeoutSeconds') delete out['toolWallMs'];
        if (k === 'toolWallMs') delete out['toolTimeoutSeconds'];
      }
    }
  }
  return Object.freeze(out) as TaskpackLimitsDeclaration;
}

export function applyLimitsToBudgets(
  baseBudgets: TaskContract['spec']['budgets'],
  limits: TaskpackLimitsDeclaration | undefined,
): TaskContract['spec']['budgets'] {
  if (!limits) return baseBudgets;
  const wallTimeMs = limits.wallTimeMs ?? (limits.wallTimeSeconds !== undefined ? limits.wallTimeSeconds * 1000 : baseBudgets.wallTimeMs);
  const perCallOutputTokens = limits.maxOutputTokens ?? limits.perCallOutputTokens ?? baseBudgets.perCallOutputTokens;
  return Object.freeze({
    ...baseBudgets,
    wallTimeMs,
    totalTokens: limits.totalTokens ?? baseBudgets.totalTokens,
    perCallOutputTokens,
    maxModelCalls: limits.maxModelCalls ?? baseBudgets.maxModelCalls,
    maxFormatRepairs: limits.maxFormatRepairs ?? baseBudgets.maxFormatRepairs,
    maxImplementationRepairs: limits.maxImplementationRepairs ?? baseBudgets.maxImplementationRepairs,
    maxTransportRetries: limits.maxTransportRetries ?? baseBudgets.maxTransportRetries,
  });
}

function manifestInvalid(message: string, path: string | null): never {
  throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', message, path);
}

function bindingInvalid(message: string, path: string | null = null): never {
  throw new GitHubAppError('TASKPACK_HOST_BINDING_INVALID', message, path);
}

function deriveControlRoot(relativeTaskpackPath: string | undefined): string {
  if (relativeTaskpackPath === undefined) return '.loopwright';
  const dir = posix.dirname(relativeTaskpackPath);
  return dir === '.' || dir === '' ? '.loopwright' : dir;
}

/** Resolve the control root and optional repository-relative manifest path for a validated manifest. */
export function resolveManifestControlRoot(
  manifest: TaskpackManifest,
  taskpackPath?: string,
): { readonly controlRoot: string; readonly manifestPath?: string } {
  const normalized = taskpackPath === undefined
    ? undefined
    : normalizeRelativePath(posix.normalize(taskpackPath.replace(/\\/g, '/')), '/');
  if (normalized !== undefined) {
    const expectedControlRoot = deriveControlRoot(normalized);
    if (
      (manifest.controlRoot !== undefined && manifest.controlRoot !== expectedControlRoot) ||
      (manifest.manifestPath !== undefined && manifest.manifestPath !== normalized)
    ) {
      bindingInvalid('bindings.taskpackPath conflicts with manifest controlRoot or manifestPath', '/taskpackPath');
    }
  }
  if (manifest.controlRoot !== undefined) {
    return {
      controlRoot: manifest.controlRoot,
      ...(manifest.manifestPath !== undefined
        ? { manifestPath: manifest.manifestPath }
        : normalized !== undefined
          ? { manifestPath: normalized }
          : {}),
    };
  }
  if (normalized !== undefined) {
    return { controlRoot: deriveControlRoot(normalized), manifestPath: normalized };
  }
  return { controlRoot: '.loopwright' };
}

/** Compile manifest `writable` or `protected` path entries into `@loopwright/core` scope patterns. */
export function compileScopePatterns(
  entries: readonly string[] | undefined,
  mode: 'writable' | 'protected',
): readonly string[] {
  if (entries === undefined || entries.length === 0) {
    return mode === 'writable' ? Object.freeze(['**']) : Object.freeze([]);
  }
  return Object.freeze([...new Set(entries.map(entry => `${entry}/**`))]);
}

async function assertNoSymlinkInSubpath(
  repositoryRoot: string,
  relativePath: string,
  onInvalid: (message: string) => never,
): Promise<string> {
  const resolvedRoot = resolve(repositoryRoot);
  const rootStat = await lstat(resolvedRoot).catch(() => null);
  if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    onInvalid('repository root must be an existing non-symlink directory');
  }
  const segments = relativePath.split('/').filter(Boolean);
  let current = resolvedRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (st === null) onInvalid(`path "${relativePath}" does not exist`);
    if (st.isSymbolicLink()) onInvalid(`path "${relativePath}" must not contain symbolic links`);
  }
  const realRoot = await realpath(resolvedRoot).catch(() => onInvalid('repository root does not exist'));
  const realFull = await realpath(current).catch(() => onInvalid(`path "${relativePath}" does not exist`));
  if (realFull !== realRoot && !realFull.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
    onInvalid(`path "${relativePath}" escapes the repository root`);
  }
  return current;
}

/**
 * Stage compiled `spec.instructions` files inside `registryDirectory` with `0o700` intermediate
 * directories and `0o600` regular files so `loadTrustedConfiguration` accepts them.
 */
export async function stageCompiledInstructionResources(
  registryDirectory: string,
  resources: readonly CompiledInstructionResource[] | undefined,
): Promise<void> {
  if (resources === undefined || resources.length === 0) return;
  const baseDir = resolve(registryDirectory);
  for (const resource of resources) {
    const rel = normalizeRelativePath(resource.path, '/spec/instructions');
    const segments = rel.split('/');
    let current = baseDir;
    for (const dirSegment of segments.slice(0, -1)) {
      current = join(current, dirSegment);
      await mkdir(current, { recursive: true, mode: 0o700 });
      await chmod(current, 0o700);
    }
    const filePath = join(current, segments[segments.length - 1]!);
    await writeFile(filePath, resource.bytes, { mode: 0o600 });
    await chmod(filePath, 0o600);
  }
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

  let relativeTaskpackPath: string | undefined;
  if (resolvedRoot !== undefined) {
    const relToRoot = relative(resolvedRoot, full);
    if (relToRoot.length === 0 || relToRoot === '..' || relToRoot.startsWith(`..${sep}`) || isAbsolute(relToRoot)) {
      manifestInvalid('manifest escapes the repository root', '/');
    }
    relativeTaskpackPath = normalizeRelativePath(relToRoot.split(sep).join('/'), '/');
    await assertNoSymlinkInSubpath(resolvedRoot, relativeTaskpackPath, message => manifestInvalid(message, '/'));
  } else if (!isAbsolute(manifestPath)) {
    const rawRel = posix.normalize(manifestPath.replace(/\\/g, '/'));
    relativeTaskpackPath = normalizeRelativePath(rawRel, '/');
    const impliedRoot = resolve(process.cwd());
    await assertNoSymlinkInSubpath(impliedRoot, relativeTaskpackPath, message => manifestInvalid(message, '/'));
  }

  const controlRoot = deriveControlRoot(relativeTaskpackPath);
  const format = extname(full).toLowerCase();
  if (format !== '.yaml' && format !== '.yml' && format !== '.json') manifestInvalid('manifest extension must be .yaml, .yml, or .json', '/');
  const bytes = await readBoundedRegularFile(full, TASKPACK_MANIFEST_BYTES, message => manifestInvalid(message, '/'));
  return validateTaskpackManifest(
    parseTaskpackDocument(bytes, format === '.json' ? 'json' : 'yaml'),
    { controlRoot, manifestPath: relativeTaskpackPath },
  );
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
  const resolvedCandidates = resolveTaskpackModelCandidates(manifest, bindings, { modelsConfig });
  const { selection } = resolveTaskpackModelSelection(manifest, bindings, modelsConfig);
  const providerEnv = requireEnvName(bindings.credentialEnvMap.provider, 'provider');
  const runtime = await runtimeIdentity();
  const installed = await installedHandlerDigests();
  const authorPrompt = bindings.authorPrompt ?? DEFAULT_AUTHOR_PROMPT_HEAD;
  const { controlRoot, manifestPath } = resolveManifestControlRoot(manifest, bindings.taskpackPath);
  const memoryRoot = `${controlRoot}/memory`;
  if (!pathCoveredBy(manifest.spec.memory.directory, memoryRoot)) {
    throw new GitHubAppError(
      'TASKPACK_SCOPE_VIOLATION',
      `memory directory "${manifest.spec.memory.directory}" is not under "${memoryRoot}"`,
      '/spec/memory/directory',
    );
  }

  const instructionResources: CompiledInstructionResource[] = [];
  if (manifest.spec.instructions !== undefined && manifest.spec.instructions.length > 0) {
    if (bindings.repositoryRoot === undefined || bindings.repositoryRoot.trim().length === 0) {
      bindingInvalid('spec.instructions requires bindings.repositoryRoot', '/spec/instructions');
    }
    let aggregateBytes = 0;
    for (const [index, relPath] of manifest.spec.instructions.entries()) {
      const diagPath = `/spec/instructions/${index}`;
      const fullPath = await assertNoSymlinkInSubpath(
        bindings.repositoryRoot,
        relPath,
        message => manifestInvalid(message, diagPath),
      );
      const rawBytes = await readBoundedRegularFile(
        fullPath,
        INSTRUCTION_MAX_AGGREGATE_BYTES,
        message => manifestInvalid(message, diagPath),
      );
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
      } catch {
        manifestInvalid(`spec.instructions[${index}] is not valid UTF-8`, diagPath);
      }
      aggregateBytes += rawBytes.byteLength;
      if (aggregateBytes > INSTRUCTION_MAX_AGGREGATE_BYTES) {
        manifestInvalid(`spec.instructions exceeds ${INSTRUCTION_MAX_AGGREGATE_BYTES} aggregate bytes`, diagPath);
      }
      const slug = relPath
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/g, '') || 'file';
      const id = `instruction-${index}-${slug}`;
      const bytes = Buffer.from(rawBytes);
      const digest = { algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') };
      instructionResources.push(Object.freeze({ id, kind: 'instruction' as const, path: relPath, bytes, digest }));
    }
  }

  const mergedLimits = mergeTaskpackLimits(manifest.spec.limits, bindings.limits);
  const commandGateMetaByCheckId = new Map<string, CompiledLocalCommandGate>();
  const commandScripts: string[] = [];
  const hasCommandChecks = manifest.spec.verification.localChecks.some(c => c.implementation === 'command.v1');
  if (hasCommandChecks) {
    if (candidate && (bindings.repositoryRoot === undefined || bindings.repositoryRoot.trim().length === 0)) {
      bindingInvalid('command.v1 checks require bindings.repositoryRoot', '/spec/verification/localChecks');
    }
    const activeCredentialEnvs = new Set<string>([
      providerEnv,
      ...(bindings.credentialEnvMap.provider !== undefined ? [bindings.credentialEnvMap.provider] : []),
      ...(bindings.sourceTokenEnvNames ?? []),
      ...resolvedCandidates.flatMap(candidate => [
        candidate.providerEnvName,
        ...(candidate.sourceTokenEnvName !== undefined ? [candidate.sourceTokenEnvName] : []),
      ]),
      ...(bindings.credentialEnvMap.gate !== undefined ? [bindings.credentialEnvMap.gate] : []),
      ...(bindings.credentialEnvMap.localCommandGate !== undefined ? [bindings.credentialEnvMap.localCommandGate] : []),
      ...(bindings.credentialEnvMap.publication !== undefined ? [bindings.credentialEnvMap.publication] : []),
      ...(bindings.credentialEnvMap.publicationAuth !== undefined ? [bindings.credentialEnvMap.publicationAuth] : []),
      ...(modelsConfig === undefined
        ? []
        : [...modelsConfig.providers.values()].map(p => p.apiKeyEnv).filter((v): v is string => v !== undefined)),
      ...(manifest.spec.models === undefined
        ? []
        : manifest.spec.models.map(m => m.apiKeyEnv).filter((v): v is string => v !== undefined)),
      ...collectMcpReferencedEnvNames(manifest.spec.mcp?.servers),
    ]);
    for (const [index, declared] of manifest.spec.verification.localChecks.entries()) {
      if (declared.implementation !== 'command.v1') continue;
      const rawEnv = declared.parameters?.['env'];
      if (Array.isArray(rawEnv)) {
        for (const envEntry of rawEnv) {
          if (typeof envEntry === 'string' && activeCredentialEnvs.has(envEntry)) {
            manifestInvalid(
              `command.v1 env "${envEntry}" must not reference a provider or host credential environment variable`,
              `/spec/verification/localChecks/${index}/parameters/env`,
            );
          }
        }
      }
      const script = String(declared.parameters?.['script'] ?? '');
      commandScripts.push(script);
      if (bindings.repositoryRoot !== undefined && bindings.repositoryRoot.trim().length > 0) {
        const diagPath = `/spec/verification/localChecks/${index}/parameters/script`;
        const fullScriptPath = await assertNoSymlinkInSubpath(
          bindings.repositoryRoot,
          script,
          message => manifestInvalid(message, diagPath),
        );
        const scriptBytes = await readBoundedRegularFile(
          fullScriptPath,
          COMMAND_SCRIPT_MAX_BYTES,
          message => manifestInvalid(message, diagPath),
        );
        if (scriptBytes.byteLength === 0) {
          manifestInvalid('command.v1 script must not be empty', diagPath);
        }
        const scriptSha256 = createHash('sha256').update(scriptBytes).digest('hex');
        const gateId = `cmd-${index}-${declared.id.slice(0, 40)}-${scriptSha256.slice(0, 16)}`;
        const timeoutSeconds = typeof declared.parameters?.['timeoutSeconds'] === 'number'
          ? declared.parameters['timeoutSeconds']
          : (mergedLimits.commandTimeoutSeconds ?? 30);
        const allowReadOnlyGitHubToken = declared.parameters?.['allowReadOnlyGitHubToken'] === true;
        const env = Array.isArray(declared.parameters?.['env'])
          ? Object.freeze([...(declared.parameters['env'] as readonly string[])])
          : Object.freeze([]);
        commandGateMetaByCheckId.set(declared.id, Object.freeze({
          checkId: declared.id,
          gateId,
          endpointRef: LOCAL_COMMAND_GATE_ENDPOINT_ID,
          script,
          scriptSha256,
          timeoutSeconds,
          allowReadOnlyGitHubToken,
          env,
        }));
      }
    }
  }

  const publicationEnabled = candidate && manifest.spec.publication.mode === 'pull_request';
  const publicationEndpoint = publicationEnabled ? bindings.publicationEndpoint : undefined;
  if (publicationEnabled && (publicationEndpoint === undefined || publicationEndpoint === null)) {
    bindingInvalid('candidate mode with pull_request publication requires a publicationEndpoint host binding');
  }
  const gatePlans = candidate ? [...(bindings.gateEndpoints ?? [])] : [];
  const gates = candidate ? manifest.spec.verification.externalGates : [];
  const externalEndpointPlans = gatePlans.filter(
    plan => plan.id !== LOCAL_COMMAND_GATE_ENDPOINT_ID || gates.some(gate => gate.endpointId === plan.id),
  );
  if (gates.length > 0) {
    if (externalEndpointPlans.length === 0) bindingInvalid('external gates require gateEndpoints host bindings');
    const externalSigningRefs = new Set(externalEndpointPlans.map(plan => plan.signingCredentialRef));
    if (externalSigningRefs.size !== 1) bindingInvalid('all gate endpoints must share one signingCredentialRef');
  }
  const externalGateEnv = gates.length > 0 ? requireEnvName(bindings.credentialEnvMap.gate, 'gate') : null;
  const externalGateSigningRef = gates.length > 0 ? externalEndpointPlans[0]!.signingCredentialRef : null;
  const publicationEnv = publicationEnabled ? requireEnvName(bindings.credentialEnvMap.publication, 'publication') : null;
  const publicationAuthEnabled = publicationEnabled
    && publicationEndpoint != null
    && publicationEndpoint.authCredentialRef != null
    && publicationEndpoint.authCredentialRef !== publicationEndpoint.signingCredentialRef;
  const publicationAuthEnv = publicationAuthEnabled
    ? requireEnvName(bindings.credentialEnvMap.publicationAuth ?? 'LOOPWRIGHT_PUBLICATION_AUTH_TOKEN', 'publicationAuth')
    : null;

  interface ActiveCheck {
    readonly id: string;
    readonly implementation: 'json-artifact.v1' | 'scope.v1' | 'no-change.v1' | 'gate.v1';
    readonly parameters: Record<string, unknown>;
    readonly allowedEvidenceLevels: readonly ('local_execution' | 'external_service')[];
  }
  const activeChecks: ActiveCheck[] = [];
  const localCommandGates: CompiledLocalCommandGate[] = [];
  if (candidate) {
    for (const declared of manifest.spec.verification.localChecks) {
      if (declared.implementation === 'command.v1') {
        const meta = commandGateMetaByCheckId.get(declared.id);
        if (meta === undefined) {
          bindingInvalid(`command.v1 check "${declared.id}" could not be compiled without repositoryRoot`);
        }
        activeChecks.push({
          id: declared.id,
          implementation: 'gate.v1',
          parameters: {
            checkId: declared.id,
            endpointRef: LOCAL_COMMAND_GATE_ENDPOINT_ID,
            gateId: meta.gateId,
          },
          allowedEvidenceLevels: ['external_service'],
        });
        localCommandGates.push(meta);
        continue;
      }
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

  let localCmdGateEnv: string | null = null;
  let localCmdGateSigningRef: string | null = null;
  if (candidate && localCommandGates.length > 0) {
    let localPlan = gatePlans.find(plan => plan.id === LOCAL_COMMAND_GATE_ENDPOINT_ID);
    if (localPlan === undefined) {
      const maxCmdSec = Math.max(30, ...localCommandGates.map(g => g.timeoutSeconds));
      const localTimeoutMs = Math.min(3_600_000, Math.max(58_000, maxCmdSec * 1000 + 15_000));
      const localMaxPollMs = Math.min(3_600_000, Math.max(120_000, localTimeoutMs + 15_000));
      localPlan = {
        id: LOCAL_COMMAND_GATE_ENDPOINT_ID,
        url: 'http://127.0.0.1:65535/loopwright-local-command',
        signingCredentialRef: 'taskpack-local-command-signing',
        authCredentialRef: null,
        timeoutMs: localTimeoutMs,
        maxPollMs: localMaxPollMs,
        pollInitialMs: 200,
        pollMaxMs: 5_000,
        jitter: 100,
      };
      gatePlans.push(localPlan);
    }
    localCmdGateSigningRef = localPlan.signingCredentialRef;
    localCmdGateEnv = requireEnvName(
      bindings.credentialEnvMap.localCommandGate ?? DEFAULT_LOCAL_COMMAND_GATE_ENV,
      'localCommandGate',
    );
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
    return assemble({
      manifest, bindings, selection, mode: 'candidate', resourceVersion, authorPrompt, runtime, installed,
      providerEnv, externalGateEnv, externalGateSigningRef, localCmdGateEnv, localCmdGateSigningRef,
      publicationEnv, publicationAuthEnv, activeChecks, steps, required: [...required], authorStepId, gatePlans, publicationEndpoint,
      controlRoot, manifestPath, instructionResources, localCommandGates, commandScripts,
    });
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
    externalGateEnv: null, externalGateSigningRef: null, localCmdGateEnv: null, localCmdGateSigningRef: null,
    publicationEnv: null, publicationAuthEnv: null, activeChecks: [noChangeCheck], steps: noChangeSteps,
    required: [noChangeCheck.id], authorStepId, gatePlans: [], publicationEndpoint: undefined,
    controlRoot, manifestPath, instructionResources, localCommandGates: [], commandScripts,
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
  readonly externalGateEnv: string | null;
  readonly externalGateSigningRef: string | null;
  readonly localCmdGateEnv: string | null;
  readonly localCmdGateSigningRef: string | null;
  readonly publicationEnv: string | null;
  readonly publicationAuthEnv: string | null;
  readonly activeChecks: readonly { readonly id: string; readonly implementation: string; readonly parameters: Record<string, unknown>; readonly allowedEvidenceLevels: readonly ('local_execution' | 'external_service')[] }[];
  readonly steps: readonly { id: string; kind: 'agent' | 'check'; uses: string; roleId: string | null; dependsOn: string[] }[];
  readonly required: readonly string[];
  readonly authorStepId: string;
  readonly gatePlans: readonly HostGateEndpointPlan[];
  readonly publicationEndpoint: HostTaskpackBindings['publicationEndpoint'];
  readonly controlRoot: string;
  readonly manifestPath: string | undefined;
  readonly instructionResources: readonly CompiledInstructionResource[];
  readonly localCommandGates: readonly CompiledLocalCommandGate[];
  readonly commandScripts: readonly string[];
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
  if (input.externalGateEnv !== null && input.externalGateSigningRef !== null) {
    credentialBindings.push({
      id: input.externalGateSigningRef,
      consumer: 'gate',
      destinationRef: 'taskpack-gate-signing',
      environmentNames: [input.externalGateEnv],
      template: `\${${input.externalGateEnv}}`,
    });
  }
  if (
    input.localCmdGateEnv !== null &&
    input.localCmdGateSigningRef !== null &&
    input.localCmdGateSigningRef !== input.externalGateSigningRef
  ) {
    credentialBindings.push({
      id: input.localCmdGateSigningRef,
      consumer: 'gate',
      destinationRef: 'taskpack-local-command-signing',
      environmentNames: [input.localCmdGateEnv],
      template: `\${${input.localCmdGateEnv}}`,
    });
  }
  if (input.publicationEnv !== null && input.publicationEndpoint !== undefined && input.publicationEndpoint !== null) {
    credentialBindings.push({
      id: input.publicationEndpoint.signingCredentialRef, consumer: 'publisher', destinationRef: 'taskpack-publication-signing',
      environmentNames: [input.publicationEnv], template: `\${${input.publicationEnv}}`,
    });
    if (
      input.publicationAuthEnv !== null
      && input.publicationEndpoint.authCredentialRef != null
      && input.publicationEndpoint.authCredentialRef !== input.publicationEndpoint.signingCredentialRef
    ) {
      credentialBindings.push({
        id: input.publicationEndpoint.authCredentialRef,
        consumer: 'publisher',
        destinationRef: 'taskpack-publication-auth',
        environmentNames: [input.publicationAuthEnv],
        template: `\${${input.publicationAuthEnv}}`,
      });
    }
  }
  const envPaths = new Map<string, string[]>();
  for (const [index, binding] of credentialBindings.entries()) {
    const envName = binding.environmentNames[0]!;
    const paths = envPaths.get(envName) ?? [];
    paths.push(`/spec/credentials/${index}/template`);
    envPaths.set(envName, paths);
  }
  const environmentBindings = [...envPaths.entries()].map(([name, paths]) => ({
    name, classification: 'credential' as const, paths,
  }));
  const handlers = [
    {
      id: 'taskpack-author', kind: 'agent' as const, implementation: 'pi.agent.v1' as const, version: 1 as const,
      digest: { ...installed['pi.agent.v1']! }, parameters: { prompt: input.authorPrompt, purpose: 'task' }, capabilities: ['pi'],
    },
    ...input.activeChecks.map(check => ({
      id: check.id, kind: 'check' as const, implementation: check.implementation as 'json-artifact.v1' | 'scope.v1' | 'no-change.v1' | 'gate.v1',
      version: 1 as const, digest: { ...installed[check.implementation]! }, parameters: check.parameters as Readonly<Record<string, Json>>,
      capabilities: check.implementation === 'gate.v1' ? ['external_service', 'read_only'] : ['inert_bytes', 'read_only'],
    })),
    {
      id: 'scope', kind: 'check' as const, implementation: 'scope.v1' as const, version: 1 as const,
      digest: { ...installed['scope.v1']! }, parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'],
    },
    {
      id: 'no-change', kind: 'check' as const, implementation: 'no-change.v1' as const, version: 1 as const,
      digest: { ...installed['no-change.v1']! }, parameters: { checkId: null }, capabilities: ['inert_bytes', 'read_only'],
    },
  ];
  const catalogRecord = resolveCatalogModel(selection).record;
  const mergedLimits = mergeTaskpackLimits(manifest.spec.limits, bindings.limits);
  const baseBudgetsWithManifest = bindings.budgets === DEFAULT_HOST_BUDGETS
    ? applyLimitsToBudgets(DEFAULT_HOST_BUDGETS, manifest.spec.limits)
    : bindings.budgets;
  const requestedBudgets = applyLimitsToBudgets(baseBudgetsWithManifest, bindings.limits);
  const defaultWorkingWindow = Math.min(16_777_216, Math.max(8_388_608, catalogRecord.contextWindow));
  const workingWindowCeiling = mergedLimits.workingWindowBytes ?? defaultWorkingWindow;
  const maxRequestBytes = Math.min(mergedLimits.maxRequestBytes ?? 8_388_608, workingWindowCeiling);
  const serviceMargin = Math.min(32_768, Math.floor(workingWindowCeiling / 4));
  const toolReserve = Math.min(16_384, Math.floor(workingWindowCeiling / 8));
  const usableWindow = Math.min(catalogRecord.contextWindow, workingWindowCeiling) - serviceMargin - toolReserve;
  const externalToolCount = bindings.externalMcpTools?.length ?? 0;
  const instructionBytes = input.instructionResources.reduce((sum, r) => sum + r.bytes.byteLength, 0);
  const promptBytesEst = Buffer.byteLength(input.authorPrompt, 'utf8');
  const baseInputHeadroom = usableWindow > 8_192
    ? Math.min(65_536, Math.floor(usableWindow * 0.8))
    : 4_096;
  const estimatedFixedInput = externalToolCount > 0 || instructionBytes > 8_192
    ? 12_288 + instructionBytes + promptBytesEst + externalToolCount * 1_600 + 8_192
    : 0;
  const maxInputHeadroom = usableWindow >= 24_576
    ? usableWindow - 8_192
    : Math.max(0, usableWindow - Math.max(1_024, Math.floor(usableWindow * 0.2)));
  const inputHeadroom = usableWindow > 8_192
    ? Math.min(maxInputHeadroom, Math.max(baseInputHeadroom, estimatedFixedInput))
    : 4_096;
  const maxWindowOutput = Math.max(1, usableWindow - inputHeadroom);
  const effectiveOutputTokens = Math.min(requestedBudgets.perCallOutputTokens, catalogRecord.maxTokens, maxWindowOutput, 262_144);

  const hasPublication = candidate && publicationEndpoints.length > 0;
  const verifierSlotCount = input.activeChecks.length + 2;
  const calcD = (attempts: number, implRepairs: number): number =>
    4 + 3 * attempts + 2 * verifierSlotCount * (1 + Math.min(attempts, 1 + implRepairs)) + (hasPublication ? 3 : 0);
  let effectiveMaxAttempts = mergedLimits.maxAttempts ?? 5;
  let effectiveImplRepairs = requestedBudgets.maxImplementationRepairs;
  while (effectiveMaxAttempts > 1 && calcD(effectiveMaxAttempts, effectiveImplRepairs) > 64) {
    effectiveMaxAttempts -= 1;
  }
  if (effectiveMaxAttempts === 1 && calcD(1, effectiveImplRepairs) > 64) {
    while (effectiveImplRepairs > 0 && calcD(1, effectiveImplRepairs) > 64) {
      effectiveImplRepairs -= 1;
    }
  }
  if (calcD(effectiveMaxAttempts, effectiveImplRepairs) > 64) {
    manifestInvalid('verification check count exceeds controller 64-checkpoint schedule capacity', '/spec/verification');
  }
  // Ensure total operation capacity fits LocalRunStore's 2048-operation lifetime cap.
  const capV = 1 + Math.min(effectiveMaxAttempts, 1 + effectiveImplRepairs);
  const capJ = verifierSlotCount * capV;
  const maxAllowedModelCalls = Math.max(1, Math.min(1024, 2048 - capJ - (hasPublication ? 1 : 0) - 3 * effectiveMaxAttempts));
  const effectiveModelCalls = Math.min(requestedBudgets.maxModelCalls, maxAllowedModelCalls);
  const effectiveFormatRepairs = Math.min(requestedBudgets.maxFormatRepairs, effectiveModelCalls);
  effectiveImplRepairs = Math.min(effectiveImplRepairs, effectiveModelCalls);

  const effectiveBudgets: TaskContract['spec']['budgets'] = {
    ...requestedBudgets,
    perCallOutputTokens: effectiveOutputTokens,
    maxFormatRepairs: effectiveFormatRepairs,
    maxImplementationRepairs: effectiveImplRepairs,
    maxModelCalls: effectiveModelCalls,
  };
  const drainReserveMs = effectiveBudgets.wallTimeMs >= 300_000
    ? DRAIN_RESERVE_MS
    : Math.max(5_000, Math.floor(effectiveBudgets.wallTimeMs / 5));

  const authorTools = Object.freeze([
    'read', 'write', 'edit', 'bash', 'delete',
    ...(bindings.externalMcpTools ?? []),
  ]);
  const roleLimits = {
    promptBytes: mergedLimits.promptBytes ?? 262_144,
    responseBytes: mergedLimits.responseBytes ?? 67_108_864,
    toolArgsBytes: mergedLimits.toolArgsBytes ?? 1_048_576,
    toolResultBytes: mergedLimits.toolResultBytes ?? 1_048_576,
    sessionBytes: mergedLimits.sessionBytes ?? 33_554_432,
    artifactBytes: 268_435_456,
    candidateEntries: mergedLimits.candidateEntries ?? 4_096,
    fileBytes: mergedLimits.fileBytes ?? 33_554_432,
    toolWallMs: mergedLimits.toolWallMs ?? (mergedLimits.toolTimeoutSeconds !== undefined ? mergedLimits.toolTimeoutSeconds * 1000 : 300_000),
  };

  const registry: TrustedRegistry = {
    apiVersion: CONTROLLER_API_VERSION, kind: 'TrustedRegistry', metadata: { name: registryName },
    spec: {
      version: 1 as const, resourceVersion: input.resourceVersion, handlers,
      roleProfiles: [{
        id: 'taskpack-author-role',
        selection,
        tools: authorTools,
        context: {
          mode: 'estimated_guard' as const, estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1,
          evidence: 'estimated' as const, workingWindowCeiling, maxRequestBytes, serviceMargin,
          toolReserve, maxOutputTokens: effectiveOutputTokens,
        },
        limits: roleLimits,
        runtimeRef: 'taskpack-runtime', providerCredentialRef: 'taskpack-provider-token',
        mcp: { serverId: 'workspace', scriptDigest: runtime.localMcpScriptDigest, names: [], effects: [], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 },
      }],
      resources: input.instructionResources.map(r => ({
        id: r.id,
        kind: r.kind,
        path: r.path,
        digest: r.digest,
      })),
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
  const fullProtected = effectiveProtectedPaths(manifest.spec.scope.protected, {
    controlRoot: input.controlRoot,
    manifestPath: input.manifestPath,
    instructions: manifest.spec.instructions,
    commandScripts: input.commandScripts,
  });
  const compiledResources = input.instructionResources.map(r => ({
    id: r.id,
    kind: r.kind,
    path: r.path,
    digest: r.digest,
  }));
  const task = {
    apiVersion: 'loopwright.dev/v1alpha1' as const, kind: 'TaskContract' as const,
    spec: {
      goal: candidate ? manifest.spec.goal.candidate : manifest.spec.goal.noChange,
      taskpack: manifest.metadata.name,
      target: { repository: bindings.repository, baseRevision: bindings.baseRevision, sourceRevision: bindings.sourceRevision, matrix: null },
      scope: {
        writable: [...compileScopePatterns(manifest.spec.scope.writable, 'writable')],
        protected: [...compileScopePatterns(fullProtected, 'protected')],
      },
      roles: [{
        id: 'author', adapter: 'pi', provider: selection.provider, model: selection.model,
        thinking: selection.thinking, tools: [...authorTools],
      }],
      trustedContext: { revision: input.resourceVersion, discovery: 'disabled' as const, resources: compiledResources },
      budgets: effectiveBudgets,
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
      controls: { drainReserveMs, maxAttempts: effectiveMaxAttempts, repeatFailureLimit: 2, submission: { mode: 'artifact_or_assistant', path: null } },
      publication: candidate && publicationEndpoints.length > 0
        ? {
          mode: 'pull_request', endpointRef: publicationEndpoints[0]!.id,
          targetBranch: manifest.spec.publication.targetBranch, headBranchPrefix: manifest.spec.publication.headBranchPrefix,
          titleTemplate: manifest.spec.publication.titleTemplate,
        }
        : { mode: 'disabled' as const },
    },
  };
  return {
    registry,
    config,
    registrySha256,
    registryBytes,
    ...(input.instructionResources.length > 0 ? { instructionResources: Object.freeze([...input.instructionResources]) } : {}),
    ...(input.localCommandGates.length > 0 ? { localCommandGates: Object.freeze([...input.localCommandGates]) } : {}),
  };
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

/** Parse the first comment line as `<prefix> <command>` or bare `<prefix>` (when `revise` is enabled with non-empty guidance); anything else returns null. */
export function parseCommentCommand(body: string, prefixes: readonly string[], commands: readonly TaskpackCommentCommand[]): ParsedCommentCommand | null {
  const lines = body.split('\n');
  const firstLine = lines[0]?.trimEnd() ?? '';
  for (const prefix of prefixes) {
    if (firstLine.startsWith(`${prefix} `)) {
      const remainder = firstLine.slice(prefix.length).trim();
      const command = remainder.split(/\s+/)[0] ?? '';
      if (!(commands as readonly string[]).includes(command)) return null;
      return { command: command as TaskpackCommentCommand, guidance: lines.slice(1).join('\n') };
    }
    if (firstLine.trim() === prefix) {
      if (!(commands as readonly string[]).includes('revise')) return null;
      const guidance = lines.slice(1).join('\n');
      if (guidance.trim().length === 0) return null;
      return { command: 'revise', guidance };
    }
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
