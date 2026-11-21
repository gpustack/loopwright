import { posix } from 'node:path';
import {
  LIMITS,
  OVERLAY_LIMITS,
  matchesScopePattern,
  resolveOverlayLimits,
  validateScopePattern,
  type OverlayLimits,
  type ReworkPolicy,
} from '@loopwright/core';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
import { DECISION_PROVIDER_API_KEY_ENV } from '@loopwright/decisions';
import {
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_MEMORY_MAX_PROMPT_ENTRIES,
  DEFAULT_MEMORY_TTL_DAYS,
} from '@loopwright/memory';
import {
  DEFAULT_COMMENT_PREFIXES, GITHUB_PROTECTED_AUTOMATION_PATHS, LOCAL_PROTECTED_AUTOMATION_PATHS,
  LOCAL_COMMAND_GATE_ENDPOINT_ID, MAX_STEP_REWORKS, MAX_TASKPACK_ROLES, MAX_TASKPACK_STEPS,
  MULTI_TENANT_HOST_POLICY, TASKPACK_COMMENT_COMMANDS, TASKPACK_MANIFEST_API_VERSION,
  TASKPACK_MANIFEST_BYTES, TASKPACK_OUTPUT_FORMATS, TASKPACK_TOOL_NAMES, TaskpackError,
  type ExecutionHostPolicy, type PolicyProfile,
  type ResolvedTaskpackExecutionCapabilities, type SandboxBackendId, type SandboxCapability,
  type SandboxNetworkMode, type TargetMatrixCell,
  type TaskpackCheckParameterValue, type TaskpackCommentCommand, type TaskpackDecisionDisclosurePolicy,
  type TaskpackDecisionProviderKind, type TaskpackDecisionsDeclaration, type TaskpackDecisionTriageRule,
  type TaskpackDecisionTriageRuleKind, type TaskpackDecisionTriageSeverity,
  type TaskpackExecutionCapabilitiesDeclaration, type TaskpackExecutionDeclaration,
  type TaskpackExecutionDigestsDeclaration, type TaskpackExecutionMode,
  type TaskpackExternalGateDeclaration, type TaskpackHttpMcpServerDeclaration,
  type TaskpackLimitsDeclaration, type TaskpackManifest, type TaskpackManifestWithProposal, type TaskpackMcpDeclaration,
  type TaskpackMcpServerDeclaration, type TaskpackMemoryApplyMode, type TaskpackMemoryDeclaration,
  type TaskpackMemoryNoBudgetMode, type TaskpackModelDeclaration, type TaskpackOutputDeclaration,
  type TaskpackOutputFormat, type TaskpackPreflightDeclaration, type TaskpackProposalDeclaration,
  type TaskpackPublicationDeclaration, type TaskpackRoleDeclaration, type TaskpackRolePurpose,
  type TaskpackSandboxDeclaration, type TaskpackStdioMcpServerDeclaration, type TaskpackStepDeclaration,
  type TaskpackStepKind, type TaskpackSubmissionDeclaration, type TaskpackTargetDeclaration,
  type TaskpackToolName, type TaskpackTriggersDeclaration, type TaskpackUpstreamDescriptor,
  type TaskpackUpstreamGroupDeclaration, type TaskpackUpstreamGroupPolicy,
  type TaskpackV2CheckDeclaration, type TaskpackV2Manifest,
} from './types.js';
import { parseYamlDocument, type Json } from './yaml.js';
import { validateTaskpackModelsDeclaration } from './models-config.js';

export { MULTI_TENANT_HOST_POLICY };
export type { Json };

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TARGET_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMENT_PREFIX_PATTERN = /^\/[A-Za-z0-9_-]{0,31}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESERVED_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const COMMAND_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$/;
const HTTP_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const VERSION_PATH_PATTERN = /^(?:\$(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+|\[\d+\]|\['[^'\r\n]+'\]|\["[^"\r\n]+"\])*$/;
const SECRET_VAR_KEY_PATTERN = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY|CREDENTIAL|BEARER|COOKIE|SESSION_KEY|SIGNING_KEY|GH_PAT)(?:$|_)/i;
const SECRET_VAR_VALUE_PATTERN = /(?:^|[^A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]{8,})/i;
const MAX_SPEC_VARS = 64;
const MAX_SPEC_VAR_VALUE_LENGTH = 512;
const MAX_DECISION_TRIAGE_RULES = 100;
const RESERVED_COMMAND_ENV_NAMES = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'BASH_ENV', 'ENV', 'NODE_OPTIONS',
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LLM_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'NPM_TOKEN', 'NODE_AUTH_TOKEN',
  ...Object.values(STANDARD_PI_PROVIDER_ENV),
  ...Object.values(DECISION_PROVIDER_API_KEY_ENV).flat(),
]);
const RESERVED_COMMAND_ENV_PREFIXES = [
  'LOOPWRIGHT_', 'INPUT_', 'GITHUB_APP_', 'ACTIONS_', 'RUNNER_', 'LD_', 'DYLD_', 'GIT_',
] as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_NODES = 4096;
const MAX_DEPTH = 16;
const MAX_COLLECTION = 512;
const MAX_STRING = 8192;
const DEFAULT_DECISION_MIN_CONFIDENCE = 0.8;
const DEFAULT_DECISION_CONFIRM_THRESHOLD = 0.6;

function manifestInvalid(message: string, path: string): never {
  throw new TaskpackError('TASKPACK_MANIFEST_INVALID', message, path);
}

function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new TaskpackError('TASKPACK_MANIFEST_INVALID', 'manifest bytes are not valid UTF-8', '/'); }
}

function resolvePolicyProfile(
  explicitProfile: PolicyProfile | undefined,
  hostProfile: PolicyProfile | undefined,
): PolicyProfile {
  if (explicitProfile !== undefined && explicitProfile !== 'local' && explicitProfile !== 'github') {
    throw new TaskpackError('TASKPACK_HOST_BINDING_INVALID', `unsupported policyProfile "${String(explicitProfile)}"`, '/policyProfile');
  }
  if (hostProfile !== undefined && hostProfile !== 'local' && hostProfile !== 'github') {
    throw new TaskpackError('TASKPACK_HOST_BINDING_INVALID', `unsupported hostPolicy.policyProfile "${String(hostProfile)}"`, '/hostPolicy/policyProfile');
  }
  if (explicitProfile !== undefined && hostProfile !== undefined && explicitProfile !== hostProfile) {
    throw new TaskpackError(
      'TASKPACK_HOST_BINDING_INVALID',
      `conflicting policyProfile "${explicitProfile}" and hostPolicy.policyProfile "${hostProfile}"`,
      '/policyProfile',
    );
  }
  return explicitProfile ?? hostProfile ?? 'local';
}

// ---------------------------------------------------------------------------
// Strict bounded JSON scanner (duplicate member names can never survive)
// ---------------------------------------------------------------------------

export interface ParseJsonSubsetLimits {
  readonly maxNodes?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxCollection?: number | undefined;
  readonly maxString?: number | undefined;
  readonly diagPath?: string | undefined;
}

export function parseJsonSubset(source: string, limits: ParseJsonSubsetLimits = {}): Json {
  const maxNodes = limits.maxNodes ?? MAX_NODES;
  const maxDepth = limits.maxDepth ?? MAX_DEPTH;
  const maxCollection = limits.maxCollection ?? MAX_COLLECTION;
  const maxString = limits.maxString ?? MAX_STRING;
  const rootPath = limits.diagPath ?? '/';
  let offset = 0, nodes = 0;
  const charAt = (index: number): string => source.charAt(index);
  const string = (): string => {
    const start = offset++;
    let closed = false;
    while (offset < source.length) {
      const char = charAt(offset++);
      if (char === '"') { closed = true; break; }
      if (char === '\\') offset++;
    }
    if (!closed) manifestInvalid('unterminated JSON string', rootPath);
    let value: unknown;
    try { value = JSON.parse(source.slice(start, offset)); } catch { manifestInvalid('invalid JSON string escape', rootPath); }
    if (typeof value !== 'string' || value.length > maxString) manifestInvalid('JSON string out of bounds', rootPath);
    return value;
  };
  const value = (depth: number, path: string): Json => {
    if (++nodes > maxNodes || depth > maxDepth) manifestInvalid('JSON document exceeds node or depth limits', path);
    skipSpace();
    const char = charAt(offset);
    if (char === '{') {
      offset++;
      const output: Record<string, Json> = {}, keys = new Set<string>();
      skipSpace();
      if (charAt(offset) === '}') { offset++; return output; }
      while (true) {
        skipSpace();
        if (charAt(offset) !== '"') manifestInvalid('JSON object keys must be strings', path);
        const key = string();
        if (keys.has(key)) manifestInvalid(`duplicate JSON member "${key}"`, `${path}/${key}`);
        if (FORBIDDEN_KEYS.has(key)) manifestInvalid(`forbidden JSON member "${key}"`, path);
        keys.add(key);
        skipSpace();
        if (charAt(offset++) !== ':') manifestInvalid('expected ":" after JSON member name', path);
        output[key] = value(depth + 1, `${path}/${key}`);
        skipSpace();
        const delimiter = charAt(offset++);
        if (delimiter === '}') return output;
        if (delimiter !== ',') manifestInvalid('expected "," or "}" in JSON object', path);
      }
    }
    if (char === '[') {
      offset++;
      const items: Json[] = [];
      skipSpace();
      if (charAt(offset) === ']') { offset++; return items; }
      while (true) {
        if (items.length >= maxCollection) manifestInvalid('JSON array exceeds collection limits', path);
        items.push(value(depth + 1, `${path}/${items.length}`));
        skipSpace();
        const delimiter = charAt(offset++);
        if (delimiter === ']') return items;
        if (delimiter !== ',') manifestInvalid('expected "," or "]" in JSON array', path);
      }
    }
    if (char === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (literal === null) manifestInvalid('invalid JSON value', path);
    offset += literal[0].length;
    if (literal[0] === 'true') return true;
    if (literal[0] === 'false') return false;
    if (literal[0] === 'null') return null;
    const number = Number(literal[0]);
    if (!Number.isFinite(number) || Object.is(number, -0)) manifestInvalid('JSON number out of bounds', path);
    return number;
  };
  const skipSpace = () => { while (offset < source.length && /[\x20\t\r\n]/.test(charAt(offset))) offset++; };
  const parsed = value(1, rootPath);
  skipSpace();
  if (offset !== source.length) manifestInvalid('trailing content after JSON document', rootPath);
  return parsed;
}

// ---------------------------------------------------------------------------
// Taskpack 2.0 execution trust modes, trigger checks, & dual-key host authority
// ---------------------------------------------------------------------------

/** Resolve effective execution capability booleans from `mode` defaults plus explicit manifest overrides. */
export function resolveExecutionCapabilities(
  mode: TaskpackExecutionMode,
  overrides: TaskpackExecutionCapabilitiesDeclaration = {},
): ResolvedTaskpackExecutionCapabilities {
  const privilegedDefault = mode === 'privileged';
  return Object.freeze({
    allowHostEnv: overrides.allowHostEnv ?? privilegedDefault,
    allowHostPath: overrides.allowHostPath ?? privilegedDefault,
    mountReadOnlyGit: overrides.mountReadOnlyGit ?? privilegedDefault,
    allowCheckNetwork: overrides.allowCheckNetwork ?? privilegedDefault,
    allowWorkflowWrites: overrides.allowWorkflowWrites ?? false,
    allowAgentNetwork: overrides.allowAgentNetwork ?? false,
  });
}

/**
 * Dual-key host authorization guard: fails closed unless operator-controlled host flags match
 * every privileged execution capability or `.github/workflows/**` write unlock declared by the manifest.
 */
export function validateExecutionAuthority(
  execution: TaskpackExecutionDeclaration | undefined,
  hostPolicy: ExecutionHostPolicy = {},
  extra?: { readonly localChecks?: readonly TaskpackV2CheckDeclaration[] | undefined },
): void {
  const perCheckMountReadOnlyGitIdx = extra?.localChecks?.findIndex(
    check => check.implementation === 'command.v1' && check.parameters?.['mountReadOnlyGit'] === true,
  ) ?? -1;
  const perCheckLoopbackNetIdx = extra?.localChecks?.findIndex(
    check => check.implementation === 'command.v1' && check.parameters?.['networkMode'] === 'loopback-only',
  ) ?? -1;
  if (execution === undefined && perCheckMountReadOnlyGitIdx === -1 && perCheckLoopbackNetIdx === -1) return;
  const caps = execution?.capabilities;
  const requiresPrivileged = (
    execution?.mode === 'privileged'
    || caps?.allowHostEnv === true
    || caps?.allowHostPath === true
    || caps?.mountReadOnlyGit === true
    || caps?.allowCheckNetwork === true
    || caps?.allowAgentNetwork === true
    || perCheckMountReadOnlyGitIdx !== -1
    || perCheckLoopbackNetIdx !== -1
  );
  if (requiresPrivileged && hostPolicy.allowPrivileged !== true) {
    const diagPath = execution?.mode === 'privileged'
      ? '/spec/execution/mode'
      : perCheckMountReadOnlyGitIdx !== -1
        && caps?.allowHostEnv !== true
        && caps?.allowHostPath !== true
        && caps?.mountReadOnlyGit !== true
        && caps?.allowCheckNetwork !== true
        && caps?.allowAgentNetwork !== true
        ? `/spec/verification/localChecks/${perCheckMountReadOnlyGitIdx}/parameters/mountReadOnlyGit`
        : perCheckLoopbackNetIdx !== -1
          && caps?.allowHostEnv !== true
          && caps?.allowHostPath !== true
          && caps?.mountReadOnlyGit !== true
          && caps?.allowCheckNetwork !== true
          && caps?.allowAgentNetwork !== true
          ? `/spec/verification/localChecks/${perCheckLoopbackNetIdx}/parameters/networkMode`
          : '/spec/execution/capabilities';
    throw new TaskpackError(
      'TASKPACK_HOST_BINDING_INVALID',
      'manifest requests privileged execution capabilities without operator host authorization (allowPrivileged)',
      diagPath,
    );
  }
  if (caps?.allowWorkflowWrites === true && hostPolicy.allowWorkflowWrites !== true) {
    throw new TaskpackError(
      'TASKPACK_SCOPE_VIOLATION',
      'manifest declares allowWorkflowWrites: true without operator host authorization (allowWorkflowWrites)',
      '/spec/execution/capabilities/allowWorkflowWrites',
    );
  }
}

/** Validate a full manifest's execution authority against `hostPolicy` (defaulting to `'local'` profile). */
export function validateManifestExecutionAuthority(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  hostPolicy: ExecutionHostPolicy = {},
): void {
  resolvePolicyProfile(undefined, hostPolicy.policyProfile);
  validateExecutionAuthority(manifest.spec.execution, hostPolicy, {
    localChecks: manifest.spec.verification.localChecks,
  });
}

/** Enforce multi-tenant GitHub App authority: refuses all self-granted privileged capabilities and absolute host toolchains. */
export function assertMultiTenantManifestAuthority(manifest: TaskpackManifest | TaskpackV2Manifest): void {
  validateExecutionAuthority(manifest.spec.execution, MULTI_TENANT_HOST_POLICY, {
    localChecks: manifest.spec.verification.localChecks,
  });
  for (const [checkIdx, check] of manifest.spec.verification.localChecks.entries()) {
    if (check.implementation !== 'command.v1') continue;
    const rawToolchains = check.parameters?.['toolchainPaths'];
    if (Array.isArray(rawToolchains)) {
      for (const [tIdx, entry] of rawToolchains.entries()) {
        if (typeof entry === 'string' && entry.startsWith('/')) {
          throw new TaskpackError(
            'TASKPACK_HOST_BINDING_INVALID',
            `multi-tenant control plane refuses absolute host toolchainPaths entry "${entry}"`,
            `/spec/verification/localChecks/${checkIdx}/parameters/toolchainPaths/${tIdx}`,
          );
        }
      }
    }
  }
}

export type GitHubTriggerEvent =
  | string
  | {
    readonly eventName: string;
    readonly commentCommand?: TaskpackCommentCommand | string | undefined;
  };

/** True when at least one GitHub event or comment command trigger is declared on `spec.triggers`. */
export function hasAnyDeclaredGitHubTrigger(triggers: TaskpackTriggersDeclaration): boolean {
  return triggers.schedule
    || triggers.workflowDispatch
    || triggers.releasePublished
    || triggers.commentCommands.length > 0;
}

/**
 * Check whether an incoming GitHub event (and optional comment command) is explicitly declared
 * by the manifest's `spec.triggers`. Fails closed (`false`) for undeclared or unknown events.
 */
export function isGitHubTriggerDeclared(
  triggers: TaskpackTriggersDeclaration,
  event: GitHubTriggerEvent,
): boolean {
  const eventName = typeof event === 'string' ? event : event.eventName;
  const commentCommand = typeof event === 'string' ? undefined : event.commentCommand;
  switch (eventName) {
    case 'schedule':
      return triggers.schedule === true;
    case 'workflow_dispatch':
      return triggers.workflowDispatch === true;
    case 'release':
      return triggers.releasePublished === true;
    case 'issue_comment':
    case 'pull_request_review':
    case 'pull_request_review_comment':
      if (commentCommand !== undefined) {
        return (triggers.commentCommands as readonly string[]).includes(commentCommand);
      }
      return triggers.commentCommands.length > 0;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Post-parse spec.vars validation & single-pass AST interpolation
// ---------------------------------------------------------------------------

function isPlainObjectRecord(value: unknown): value is Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoInterpolationTemplate(node: unknown, astPath: string, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof node === 'string') {
    if (node.includes('${')) {
      throw new TaskpackError(
        'TASKPACK_UNTRUSTED_INTERPOLATION',
        `interpolation expression is not permitted at "${astPath}"`,
        astPath || '/',
      );
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const [idx, item] of node.entries()) {
      assertNoInterpolationTemplate(item, `${astPath}/${idx}`, depth + 1);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key.includes('${')) {
        throw new TaskpackError(
          'TASKPACK_UNTRUSTED_INTERPOLATION',
          `interpolation expression is not permitted in object key "${key}"`,
          `${astPath}/${key}`,
        );
      }
      assertNoInterpolationTemplate(val, `${astPath}/${key}`, depth + 1);
    }
  }
}

function validateSpecVarsRecord(raw: unknown, path: string): Readonly<Record<string, string>> {
  assertNoInterpolationTemplate(raw, path);
  if (!isPlainObjectRecord(raw)) {
    manifestInvalid('spec.vars must be a plain object mapping variable names to strings', path);
  }
  const entries = Object.entries(raw);
  if (entries.length > MAX_SPEC_VARS) {
    manifestInvalid(`spec.vars exceeds ${MAX_SPEC_VARS} entries`, path);
  }
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, val] of entries) {
    const entryPath = `${path}/${key}`;
    if (FORBIDDEN_KEYS.has(key) || !COMMAND_ENV_NAME_PATTERN.test(key)) {
      manifestInvalid(`spec.vars key "${key}" must match ^[A-Z][A-Z0-9_]{0,63}$`, entryPath);
    }
    if (isReservedCommandEnvName(key) || FORBIDDEN_LITERAL_COMMAND_ENV_NAMES.has(key) || SECRET_VAR_KEY_PATTERN.test(key)) {
      manifestInvalid(`spec.vars key "${key}" must not declare reserved or secret-like variable names`, entryPath);
    }
    if (typeof val !== 'string' || val.length > MAX_SPEC_VAR_VALUE_LENGTH || /[\0\r\n]/.test(val)) {
      manifestInvalid(`spec.vars value for "${key}" must be a string of at most ${MAX_SPEC_VAR_VALUE_LENGTH} characters without control characters`, entryPath);
    }
    if (SECRET_VAR_VALUE_PATTERN.test(val)) {
      manifestInvalid(`spec.vars value for "${key}" appears to contain a secret credential`, entryPath);
    }
    out[key] = val;
  }
  return Object.freeze(out);
}

const PERMITTED_INTERPOLATION_EXACT_PATHS = new Set<string>([
  '/spec/publication/titleTemplate',
  '/spec/publication/bodyTemplate',
  '/spec/goal/candidate',
  '/spec/goal/noChange',
]);

function isPermittedInterpolationPath(astPath: string): boolean {
  if (PERMITTED_INTERPOLATION_EXACT_PATHS.has(astPath)) return true;
  if (/^\/spec\/roles\/\d+\/prompt$/.test(astPath)) return true;
  if (/^\/spec\/preflight\/env\/\d+$/.test(astPath)) return true;
  if (/^\/spec\/verification\/localChecks\/\d+\/parameters\/(?:args\/\d+|env\/[^/]+|startMarker|endMarker|allowedPointers\/\d+)$/.test(astPath)) {
    return true;
  }
  return false;
}

function validateAndInterpolateString(
  text: string,
  vars: Readonly<Record<string, string>>,
  astPath: string,
  interpolate: boolean,
): string {
  if (!text.includes('${')) return text;
  if (!isPermittedInterpolationPath(astPath)) {
    throw new TaskpackError(
      'TASKPACK_UNTRUSTED_INTERPOLATION',
      `interpolation expression is not permitted at "${astPath}"`,
      astPath || '/',
    );
  }
  let cursor = 0;
  let result = '';
  while (cursor < text.length) {
    const start = text.indexOf('${', cursor);
    if (start === -1) {
      result += text.slice(cursor);
      break;
    }
    result += text.slice(cursor, start);
    const end = text.indexOf('}', start + 2);
    if (end === -1) {
      throw new TaskpackError(
        'TASKPACK_UNTRUSTED_INTERPOLATION',
        `unterminated \${...} interpolation expression at "${astPath}"`,
        astPath || '/',
      );
    }
    const varName = text.slice(start + 2, end);
    if (!COMMAND_ENV_NAME_PATTERN.test(varName) || !Object.hasOwn(vars, varName)) {
      throw new TaskpackError(
        'TASKPACK_UNTRUSTED_INTERPOLATION',
        `undeclared interpolation variable "\${${varName}}" at "${astPath}"`,
        astPath || '/',
      );
    }
    result += vars[varName]!;
    cursor = end + 1;
  }
  if (result.includes('${')) {
    throw new TaskpackError(
      'TASKPACK_UNTRUSTED_INTERPOLATION',
      `interpolated value at "${astPath}" must not synthesize a "\${...}" expression`,
      astPath || '/',
    );
  }
  if (result.length > MAX_STRING) {
    manifestInvalid(`interpolated value at "${astPath}" exceeds ${MAX_STRING} characters`, astPath || '/');
  }
  return interpolate ? result : text;
}

function walkAstForInterpolation(
  node: Json,
  vars: Readonly<Record<string, string>>,
  astPath: string,
  interpolate: boolean,
  skipValidatedSpecVars = false,
  depth = 0,
): Json {
  if (depth > MAX_DEPTH) {
    manifestInvalid('manifest exceeds maximum nesting depth during AST validation', astPath || '/');
  }
  if (typeof node === 'string') {
    return validateAndInterpolateString(node, vars, astPath, interpolate);
  }
  if (Array.isArray(node)) {
    if (!interpolate) {
      for (const [idx, item] of node.entries()) {
        walkAstForInterpolation(item, vars, `${astPath}/${idx}`, false, skipValidatedSpecVars, depth + 1);
      }
      return node;
    }
    return node.map((item, idx) => walkAstForInterpolation(item, vars, `${astPath}/${idx}`, true, skipValidatedSpecVars, depth + 1));
  }
  if (node !== null && typeof node === 'object') {
    const proto: unknown = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      manifestInvalid('expected an object', astPath || '/');
    }
    const record = node as Record<string, Json>;
    const out: Record<string, Json> | null = interpolate ? (Object.create(null) as Record<string, Json>) : null;
    for (const [key, val] of Object.entries(record)) {
      if (key.includes('${')) {
        throw new TaskpackError(
          'TASKPACK_UNTRUSTED_INTERPOLATION',
          `interpolation expression is not permitted in object key "${key}"`,
          `${astPath}/${key}`,
        );
      }
      const childPath = `${astPath}/${key}`;
      if (skipValidatedSpecVars && childPath === '/spec/vars') {
        if (out !== null) out[key] = val;
        continue;
      }
      const visited = walkAstForInterpolation(val, vars, childPath, interpolate, skipValidatedSpecVars, depth + 1);
      if (out !== null) out[key] = visited;
    }
    return out ?? node;
  }
  return node;
}

/**
 * Parse manifest bytes in the named format and perform post-parse AST interpolation validation.
 * Oversized or non-UTF-8 input is refused before parsing; undeclared or disallowed `${...}` expressions
 * fail closed with `TASKPACK_UNTRUSTED_INTERPOLATION`.
 */
export function parseTaskpackDocument(bytes: Uint8Array, format: 'json' | 'yaml'): Json {
  if (bytes.byteLength > TASKPACK_MANIFEST_BYTES) {
    throw new TaskpackError('TASKPACK_MANIFEST_INVALID', `manifest exceeds ${TASKPACK_MANIFEST_BYTES} bytes`, '/');
  }
  const source = decodeText(bytes);
  const parsed = format === 'json' ? parseJsonSubset(source) : parseYamlDocument(source);
  const emptyVars: Readonly<Record<string, string>> = Object.freeze(Object.create(null) as Record<string, string>);
  let vars: Readonly<Record<string, string>> = emptyVars;
  let validatedSpecVars = false;
  if (isPlainObjectRecord(parsed) && parsed['kind'] === 'Taskpack' && isPlainObjectRecord(parsed['spec'])) {
    const rawVars = parsed['spec']['vars'];
    if (rawVars !== undefined) {
      vars = validateSpecVarsRecord(rawVars, '/spec/vars');
      validatedSpecVars = true;
    }
  }
  walkAstForInterpolation(parsed, vars, '', false, validatedSpecVars);
  return parsed;
}

// ---------------------------------------------------------------------------
// Path guards and scope helpers
// ---------------------------------------------------------------------------

/** Validate a manifest-declared relative path: strict `@loopwright/core` segment grammar, no traversal, no absolutes. */
export function normalizeRelativePath(input: unknown, path: string): string {
  // Cap at 1021 characters so appending `/**` during scope compilation never exceeds LIMITS.path (1024).
  if (typeof input !== 'string' || input.length === 0 || input.length > 1021) {
    manifestInvalid('path must be a non-empty string of at most 1021 characters', path);
  }
  if (input.includes('\0') || input.includes('\\') || input.includes(':')) manifestInvalid('path contains forbidden characters', path);
  if (input.startsWith('/')) manifestInvalid('path must be relative', path);
  const segments = input.split('/');
  if (segments.length > 64) manifestInvalid('path exceeds 64 segments', path);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.endsWith('.')) {
      manifestInvalid(`path segment "${segment}" is not allowed`, path);
    }
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      manifestInvalid(`path segment "${segment}" contains invalid characters`, path);
    }
    if (RESERVED_DEVICE_NAME_PATTERN.test(segment)) {
      manifestInvalid(`path segment "${segment}" is a reserved device name`, path);
    }
  }
  return input;
}

export function tryNormalizeRelativePath(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1021) return undefined;
  if (input.includes('\0') || input.includes('\\') || input.includes(':') || input.startsWith('/')) return undefined;
  const segments = input.split('/');
  if (segments.length > 64) return undefined;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.endsWith('.')) return undefined;
    if (!PATH_SEGMENT_PATTERN.test(segment)) return undefined;
    if (RESERVED_DEVICE_NAME_PATTERN.test(segment)) return undefined;
  }
  return input;
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
      throw new TaskpackError(
        'TASKPACK_HOST_BINDING_INVALID',
        'bindings.taskpackPath conflicts with manifest controlRoot or manifestPath',
        '/taskpackPath',
      );
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

/** Validate a Taskpack 2.0 scope pattern (exact path, explicit `dir/**`, or single-segment `*`/`?` glob) via `@loopwright/core`. */
export function normalizeScopePattern(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > LIMITS.path) {
    manifestInvalid(`scope pattern must be a non-empty string of at most ${LIMITS.path} characters`, path);
  }
  if (input === '**') {
    manifestInvalid('unbounded "**" scope pattern is not allowed in manifest scope declarations', path);
  }
  const validated = validateScopePattern(input);
  if (!validated.ok) {
    manifestInvalid(`invalid scope pattern "${input}": ${validated.errors[0]?.code ?? 'PATTERN_UNSUPPORTED'}`, path);
  }
  return validated.value;
}

/** True when `candidate` equals `root` or lives underneath it. */
export function pathCoveredBy(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function pathCoveredByCaseInsensitive(candidate: string, root: string): boolean {
  return pathCoveredBy(candidate.normalize('NFC').toLowerCase(), root.normalize('NFC').toLowerCase());
}

/** Exact polynomial-time check for whether two single-segment `*`/`?` patterns share any matching non-empty segment. */
function segmentsMayIntersect(a: string, b: string): boolean {
  const m = a.length;
  const n = b.length;
  const memo = new Int8Array((m + 1) * (n + 1));
  const solve = (i: number, j: number): boolean => {
    const idx = i * (n + 1) + j;
    if (memo[idx] !== 0) return memo[idx] === 1;
    let res = false;
    if (i === m && j === n) {
      res = true;
    } else if (i < m && a[i] === '*') {
      res = solve(i + 1, j) || (j < n && solve(i, j + 1));
    } else if (j < n && b[j] === '*') {
      res = solve(i, j + 1) || (i < m && solve(i + 1, j));
    } else if (i < m && j < n && (a[i] === '?' || b[j] === '?' || a[i] === b[j])) {
      res = solve(i + 1, j + 1);
    }
    memo[idx] = res ? 1 : -1;
    return res;
  };
  return solve(0, 0);
}

function splitScopePattern(pattern: string, caseInsensitive: boolean): { segments: readonly string[]; recursive: boolean } {
  const norm = caseInsensitive ? pattern.normalize('NFC').toLowerCase() : pattern;
  if (norm === '**') return { segments: [], recursive: true };
  const recursive = norm.endsWith('/**');
  const body = recursive ? norm.slice(0, -3) : norm;
  return { segments: body.split('/'), recursive };
}

/** True when two scope patterns could match at least one common repository path. */
function scopePatternsMayIntersect(patternA: string, patternB: string, caseInsensitive = false): boolean {
  const a = splitScopePattern(patternA, caseInsensitive);
  const b = splitScopePattern(patternB, caseInsensitive);
  const maxLen = Math.max(a.segments.length, b.segments.length);
  for (let k = 0; k < maxLen; k++) {
    if (k >= a.segments.length) return a.recursive;
    if (k >= b.segments.length) return b.recursive;
    if (!segmentsMayIntersect(a.segments[k]!, b.segments[k]!)) return false;
  }
  return true;
}

/** Exact polynomial-time check for whether every segment matched by `a` is also matched by `b`. */
function segmentSubsetOf(a: string, b: string): boolean {
  const m = a.length;
  const n = b.length;
  const memo = new Int8Array((m + 1) * (n + 1));
  const solve = (i: number, j: number): boolean => {
    const idx = i * (n + 1) + j;
    if (memo[idx] !== 0) return memo[idx] === 1;
    let res = false;
    if (i === m && j === n) {
      res = true;
    } else if (j < n && b[j] === '*') {
      res = solve(i, j + 1) || (i < m && solve(i + 1, j));
    } else if (i < m && j < n && a[i] !== '*' && (b[j] === '?' || a[i] === b[j])) {
      res = solve(i + 1, j + 1);
    }
    memo[idx] = res ? 1 : -1;
    return res;
  };
  return solve(0, 0);
}

/** True when every repository path matched by `sub` is also matched by `sup`. */
function scopePatternSubsetOf(sub: string, sup: string, caseInsensitive = false): boolean {
  const a = splitScopePattern(sub, caseInsensitive);
  const b = splitScopePattern(sup, caseInsensitive);
  if (b.recursive) {
    if (a.segments.length < b.segments.length) return false;
    for (let k = 0; k < b.segments.length; k++) {
      if (!segmentSubsetOf(a.segments[k]!, b.segments[k]!)) return false;
    }
    return true;
  }
  if (a.recursive || a.segments.length !== b.segments.length) return false;
  for (let k = 0; k < b.segments.length; k++) {
    if (!segmentSubsetOf(a.segments[k]!, b.segments[k]!)) return false;
  }
  return true;
}

function asProtectedSubtreePattern(protectedEntry: string): string {
  if (protectedEntry === '**' || protectedEntry.endsWith('/**')) return protectedEntry;
  return `${protectedEntry}/**`;
}

/** True when a scope pattern targets exclusively `.github/workflows` or paths inside it. */
function isWorkflowSubpathPattern(pattern: string): boolean {
  const base = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  return base === '.github/workflows' || base.startsWith('.github/workflows/');
}

function isWorkflowSubpathCaseInsensitive(pattern: string): boolean {
  const norm = pattern.normalize('NFC').toLowerCase();
  const base = norm.endsWith('/**') ? norm.slice(0, -3) : norm;
  return base === '.github/workflows' || base.startsWith('.github/workflows/');
}

function writableEntryOverlapsProtected(
  writablePattern: string,
  protectedEntry: string,
  allowWorkflowWrites: boolean,
  isBuiltInProtected: boolean,
): boolean {
  if (
    allowWorkflowWrites
    && isBuiltInProtected
    && (protectedEntry === '.github' || protectedEntry === '.github/**')
    && isWorkflowSubpathPattern(writablePattern)
  ) {
    return false;
  }
  const protectedSubtree = asProtectedSubtreePattern(protectedEntry);
  return scopePatternsMayIntersect(writablePattern, protectedSubtree, false)
    || scopePatternsMayIntersect(writablePattern, protectedSubtree, true);
}

function writableScopeCoversPath(
  writableEntry: string,
  candidatePath: string,
  legacyPrefixFallback: boolean,
): boolean {
  const matched = matchesScopePattern(writableEntry, candidatePath);
  if (matched.ok && matched.value) return true;
  if (legacyPrefixFallback && !writableEntry.includes('*') && !writableEntry.includes('?')) {
    return pathCoveredBy(candidatePath, writableEntry);
  }
  return false;
}

export interface EffectiveProtectedPathsOptions {
  readonly policyProfile?: PolicyProfile | undefined;
  readonly controlRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly digestsLockfile?: string | undefined;
  readonly instructions?: readonly string[] | undefined;
  readonly skills?: readonly string[] | undefined;
  readonly preflightScript?: string | undefined;
  readonly commandScripts?: readonly string[] | undefined;
  readonly toolchainPaths?: readonly string[] | undefined;
  readonly proposalPath?: string | undefined;
  readonly extraProtectedPaths?: readonly string[] | undefined;
  readonly controlRootSiblings?: readonly string[] | undefined;
  readonly priorityControlRootSiblings?: readonly string[] | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly githubSiblings?: readonly string[] | undefined;
}

function automationPathsFor(policyProfile: PolicyProfile, allowWorkflowWrites: boolean): readonly string[] {
  if (policyProfile === 'local') {
    return LOCAL_PROTECTED_AUTOMATION_PATHS;
  }
  if (!allowWorkflowWrites) return GITHUB_PROTECTED_AUTOMATION_PATHS;
  return GITHUB_PROTECTED_AUTOMATION_PATHS.filter(entry => entry !== '.github');
}

function commandScriptOutsideParentDir(script: string, controlRoot: string): string | undefined {
  const slash = script.lastIndexOf('/');
  if (slash <= 0) return undefined;
  const parent = script.slice(0, slash);
  if (pathCoveredBy(parent, controlRoot) || pathCoveredByCaseInsensitive(parent, controlRoot)) {
    return undefined;
  }
  return parent;
}

function explicitProtectedPathsWithoutControlRoot(
  manifestProtected: readonly string[],
  options: EffectiveProtectedPathsOptions,
): readonly string[] {
  const policyProfile = resolvePolicyProfile(options.policyProfile, undefined);
  const controlRoot = options.controlRoot ?? '.loopwright';
  const allowWorkflowWrites = policyProfile === 'github' && options.allowWorkflowWrites === true;
  const baseSet = new Set<string>([
    ...automationPathsFor(policyProfile, allowWorkflowWrites),
    `${controlRoot}/policies`,
    `${controlRoot}/checks`,
    `${controlRoot}/scripts`,
    `${controlRoot}/memory`,
    `${controlRoot}/taskpack.yaml`,
    `${controlRoot}/taskpack.yml`,
    `${controlRoot}/taskpack.json`,
    `${controlRoot}/digests.lock.json`,
  ]);
  if (options.manifestPath !== undefined) baseSet.add(options.manifestPath);
  if (options.digestsLockfile !== undefined) baseSet.add(options.digestsLockfile);
  if (options.extraProtectedPaths !== undefined) {
    for (const extra of options.extraProtectedPaths) baseSet.add(extra);
  }
  if (options.instructions !== undefined) {
    for (const instruction of options.instructions) baseSet.add(instruction);
  }
  if (options.skills !== undefined) {
    for (const skill of options.skills) baseSet.add(skill);
  }
  if (options.preflightScript !== undefined) baseSet.add(options.preflightScript);
  if (options.commandScripts !== undefined) {
    for (const script of options.commandScripts) {
      baseSet.add(script);
      const parentDir = commandScriptOutsideParentDir(script, controlRoot);
      if (parentDir !== undefined) baseSet.add(parentDir);
    }
  }
  if (options.toolchainPaths !== undefined) {
    for (const entry of options.toolchainPaths) {
      if (!entry.startsWith('/')) baseSet.add(entry);
    }
  }
  for (const entry of manifestProtected) baseSet.add(entry);
  if (options.priorityControlRootSiblings !== undefined) {
    for (const sibling of options.priorityControlRootSiblings) baseSet.add(sibling);
  }
  if (policyProfile === 'github' && allowWorkflowWrites && options.githubSiblings !== undefined) {
    for (const sibling of options.githubSiblings) {
      if (isWorkflowSubpathCaseInsensitive(sibling)) continue;
      if (baseSet.size >= 128) break;
      baseSet.add(sibling);
    }
  }
  if (options.controlRootSiblings !== undefined) {
    for (const sibling of options.controlRootSiblings) {
      if (baseSet.size >= 128) break;
      baseSet.add(sibling);
    }
  }
  return Object.freeze([...baseSet]);
}

/**
 * True when `proposalPath` is a valid `.yaml`/`.yml`/`.json` file strictly inside `controlRoot`
 * that does not overlap any built-in or manifest control-plane path.
 */
export function canCarveOutControlRootProposal(
  proposalPath: string | undefined,
  controlRoot: string,
  explicitProtectedPaths: readonly string[],
): boolean {
  if (proposalPath === undefined) return false;
  if (tryNormalizeRelativePath(proposalPath) !== proposalPath) return false;
  if (tryNormalizeRelativePath(controlRoot) !== controlRoot) return false;
  if (!/\.(?:yaml|yml|json)$/i.test(proposalPath)) return false;
  if (proposalPath === controlRoot || !pathCoveredBy(proposalPath, controlRoot)) return false;
  for (const protectedPath of explicitProtectedPaths) {
    const protectedSubtree = asProtectedSubtreePattern(protectedPath);
    if (
      scopePatternsMayIntersect(proposalPath, protectedSubtree, false)
      || scopePatternsMayIntersect(proposalPath, protectedSubtree, true)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * True when `proposalPath` inside `controlRoot` is eligible for carve-out AND `writable`
 * reaches `controlRoot` exclusively via the exact `proposalPath` file entry.
 */
export function isControlRootProposalWritableAllowed(
  proposalPath: string | undefined,
  writable: readonly string[],
  controlRoot: string,
  explicitProtectedPaths: readonly string[] = [],
): boolean {
  if (!canCarveOutControlRootProposal(proposalPath, controlRoot, explicitProtectedPaths)) return false;
  if (writable.length === 0 || !writable.includes(proposalPath!)) return false;
  const controlRootSubtree = `${controlRoot}/**`;
  for (const entry of writable) {
    if (!validateScopePattern(entry).ok) return false;
    if (entry === proposalPath) continue;
    if (scopePatternsMayIntersect(entry, controlRootSubtree, false) || scopePatternsMayIntersect(entry, controlRootSubtree, true)) {
      return false;
    }
  }
  return true;
}

/** The manifest-protected set merged with profile-scoped built-in paths and the active control root. */
export function effectiveProtectedPaths(
  manifestProtected: readonly string[],
  options: EffectiveProtectedPathsOptions = {},
): readonly string[] {
  const policyProfile = resolvePolicyProfile(options.policyProfile, undefined);
  const controlRoot = options.controlRoot ?? '.loopwright';
  const allowWorkflowWrites = policyProfile === 'github' && options.allowWorkflowWrites === true;
  const explicit = explicitProtectedPathsWithoutControlRoot(manifestProtected, options);
  if (canCarveOutControlRootProposal(options.proposalPath, controlRoot, explicit)) {
    return explicit;
  }
  const items: string[] = [
    ...automationPathsFor(policyProfile, allowWorkflowWrites),
    controlRoot,
    ...explicit,
  ];
  return Object.freeze([...new Set(items)]);
}

/** Resolve effective protected paths directly from a validated manifest (defaulting to `'local'` profile). */
export function resolveEffectiveProtectedPaths(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: EffectiveProtectedPathsOptions = {},
): readonly string[] {
  const controlRoot = options.controlRoot ?? manifest.controlRoot ?? '.loopwright';
  const manifestPath = options.manifestPath ?? manifest.manifestPath;
  const instructions = options.instructions ?? [
    ...(manifest.spec.instructions ?? []),
    ...(manifest.spec.roles ?? []).flatMap(role => role.instructions ?? []),
  ];
  const skills = options.skills ?? [
    ...(manifest.spec.skills ?? []),
    ...(manifest.spec.roles ?? []).flatMap(role => role.skills ?? []),
  ];
  const commandScripts = options.commandScripts ?? manifest.spec.verification.localChecks
    .filter(c => c.implementation === 'command.v1')
    .map(c => c.parameters?.['script'])
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const toolchainPaths = options.toolchainPaths ?? manifest.spec.verification.localChecks
    .flatMap(c => (
      c.implementation === 'command.v1' && Array.isArray(c.parameters?.['toolchainPaths'])
        ? c.parameters['toolchainPaths'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && !entry.startsWith('/'))
        : []
    ));
  return effectiveProtectedPaths(manifest.spec.scope.protected, {
    ...options,
    controlRoot,
    manifestPath,
    digestsLockfile: options.digestsLockfile ?? manifest.spec.execution?.digests.lockfile,
    instructions: instructions.length > 0 ? instructions : undefined,
    skills: skills.length > 0 ? skills : undefined,
    preflightScript: options.preflightScript ?? manifest.spec.preflight?.script,
    commandScripts: commandScripts.length > 0 ? commandScripts : undefined,
    toolchainPaths: toolchainPaths.length > 0 ? toolchainPaths : undefined,
    proposalPath: options.proposalPath ?? manifest.spec.proposal?.path,
  });
}

function resolveProtectedPathSets(
  manifestProtected: readonly string[],
  options: EffectiveProtectedPathsOptions,
): {
  readonly allProtected: readonly string[];
  readonly mandatoryProtectedSet: ReadonlySet<string>;
  readonly explicitWithManifest: readonly string[];
} {
  const policyProfile = resolvePolicyProfile(options.policyProfile, undefined);
  const controlRoot = options.controlRoot ?? '.loopwright';
  const allowWorkflowWrites = policyProfile === 'github' && options.allowWorkflowWrites === true;
  const explicitWithManifest = explicitProtectedPathsWithoutControlRoot(manifestProtected, options);
  const carvedOut = canCarveOutControlRootProposal(options.proposalPath, controlRoot, explicitWithManifest);
  const allProtected = carvedOut
    ? explicitWithManifest
    : Object.freeze([...new Set([...automationPathsFor(policyProfile, allowWorkflowWrites), controlRoot, ...explicitWithManifest])]);
  const mandatoryWithoutControlRoot = explicitProtectedPathsWithoutControlRoot([], options);
  const mandatoryProtectedSet = new Set<string>(mandatoryWithoutControlRoot);
  if (!carvedOut) mandatoryProtectedSet.add(controlRoot);
  return { allProtected, mandatoryProtectedSet, explicitWithManifest };
}

function assertWritablesDisjointFromProtected(
  writable: readonly string[],
  allProtected: readonly string[],
  mandatoryProtectedSet: ReadonlySet<string>,
  controlRoot: string,
  proposalPath: string | undefined,
  policyProfile: PolicyProfile,
  allowWorkflowWrites: boolean,
): void {
  const controlRootSubtree = `${controlRoot}/**`;
  const githubAllowWorkflows = policyProfile === 'github' && allowWorkflowWrites;
  for (const [index, entry] of writable.entries()) {
    const covering = allProtected.find(protectedPath => {
      if (mandatoryProtectedSet.has(protectedPath)) {
        return writableEntryOverlapsProtected(entry, protectedPath, githubAllowWorkflows, true);
      }
      // A broad writable pattern may encompass narrower user-only `protected` exclusions (blacklist wins),
      // so reject only when the writable pattern is a glob/case-insensitive subset of the protected pattern.
      const protectedSubtree = asProtectedSubtreePattern(protectedPath);
      return scopePatternSubsetOf(entry, protectedSubtree, false)
        || scopePatternSubsetOf(entry, protectedSubtree, true);
    });
    if (covering !== undefined) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" overlaps protected path "${covering}"`, `/spec/scope/writable/${index}`);
    }
    if (githubAllowWorkflows && writableEntryOverlapsProtected(entry, '.github', true, true)) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" overlaps protected path ".github"`, `/spec/scope/writable/${index}`);
    }
    if (
      (scopePatternsMayIntersect(entry, controlRootSubtree, false) || scopePatternsMayIntersect(entry, controlRootSubtree, true))
      && entry !== proposalPath
    ) {
      if (entry === controlRoot || scopePatternsMayIntersect(controlRoot, entry, false) || scopePatternsMayIntersect(controlRoot, entry, true)) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" encompasses protected control root "${controlRoot}"`, `/spec/scope/writable/${index}`);
      }
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `writable path "${entry}" inside control root "${controlRoot}" must exactly match spec.proposal.path`,
        `/spec/scope/writable/${index}`,
      );
    }
  }
}

/**
 * Re-validate `spec.scope` and optional `spec.proposal.path` against the resolved `(controlRoot, manifestPath)`
 * so callers passing in-memory or JSON-roundtripped manifests cannot bypass control-root or host-authority protection.
 */
export function assertManifestScopeInvariants(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: {
    readonly controlRoot: string;
    readonly manifestPath?: string | undefined;
    readonly policyProfile?: PolicyProfile | undefined;
    readonly commandScripts?: readonly string[] | undefined;
    readonly extraProtectedPaths?: readonly string[] | undefined;
    readonly controlRootSiblings?: readonly string[] | undefined;
    readonly priorityControlRootSiblings?: readonly string[] | undefined;
    readonly githubSiblings?: readonly string[] | undefined;
    readonly allowWildcardWritableWhenControlRootProtected?: boolean | undefined;
    readonly hostPolicy?: ExecutionHostPolicy | undefined;
    readonly enforceHostAuthority?: boolean | undefined;
  },
): readonly string[] {
  const policyProfile = resolvePolicyProfile(options.policyProfile, options.hostPolicy?.policyProfile);
  const controlRoot = normalizeRelativePath(options.controlRoot, '/');
  const manifestPath = options.manifestPath !== undefined ? normalizeRelativePath(options.manifestPath, '/') : undefined;
  const proposalPath = manifest.spec.proposal !== undefined
    ? normalizeRelativePath(manifest.spec.proposal.path, '/spec/proposal/path')
    : undefined;
  if (options.enforceHostAuthority !== false) {
    validateExecutionAuthority(manifest.spec.execution, options.hostPolicy, {
      localChecks: manifest.spec.verification.localChecks,
    });
  }
  const allowWorkflowWrites = (
    policyProfile === 'github'
    && manifest.spec.execution?.capabilities.allowWorkflowWrites === true
    && (options.enforceHostAuthority === false || options.hostPolicy?.allowWorkflowWrites === true)
  );
  if (manifest.spec.sandbox?.networkMode === 'allow-outbound' && manifest.spec.execution?.capabilities.allowAgentNetwork !== true) {
    throw new TaskpackError(
      'TASKPACK_SCOPE_VIOLATION',
      'spec.sandbox.networkMode "allow-outbound" requires spec.execution.capabilities.allowAgentNetwork: true',
      '/spec/sandbox/networkMode',
    );
  }
  const rawWritable = manifest.spec.scope.writable;
  const isSingleWildcardWritable = (
    options.allowWildcardWritableWhenControlRootProtected === true
    && rawWritable.length === 1
    && rawWritable[0] === '**'
  );
  const writable = isSingleWildcardWritable
    ? Object.freeze<readonly string[]>([])
    : rawWritable.map((entry, index) => normalizeScopePattern(entry, `/spec/scope/writable/${index}`));
  const manifestProtected = manifest.spec.scope.protected.map((entry, index) => (
    normalizeScopePattern(entry, `/spec/scope/protected/${index}`)
  ));
  const manifestProtectedSet = new Set(manifestProtected);
  const instructions = [
    ...(manifest.spec.instructions?.map((entry, index) => normalizeRelativePath(entry, `/spec/instructions/${index}`)) ?? []),
    ...(manifest.spec.roles?.flatMap((role, rIdx) => (
      role.instructions?.map((entry, iIdx) => normalizeRelativePath(entry, `/spec/roles/${rIdx}/instructions/${iIdx}`)) ?? []
    )) ?? []),
  ];
  const skills = [
    ...(manifest.spec.skills?.map((entry, index) => normalizeRelativePath(entry, `/spec/skills/${index}`)) ?? []),
    ...(manifest.spec.roles?.flatMap((role, rIdx) => (
      role.skills?.map((entry, sIdx) => normalizeRelativePath(entry, `/spec/roles/${rIdx}/skills/${sIdx}`)) ?? []
    )) ?? []),
  ];
  const preflightScript = manifest.spec.preflight !== undefined
    ? normalizeRelativePath(manifest.spec.preflight.script, '/spec/preflight/script')
    : undefined;
  const digestsLockfile = manifest.spec.execution?.digests.lockfile !== undefined
    ? normalizeRelativePath(manifest.spec.execution.digests.lockfile, '/spec/execution/digests/lockfile')
    : undefined;
  const rawCommandScripts = options.commandScripts ?? manifest.spec.verification.localChecks
    .filter(c => c.implementation === 'command.v1')
    .map(c => c.parameters?.['script'])
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const commandScripts = rawCommandScripts.map((entry, index) => (
    normalizeRelativePath(entry, `/spec/verification/localChecks/${index}/parameters/script`)
  ));
  const relativeToolchainPaths: string[] = [];
  for (const [cIdx, check] of manifest.spec.verification.localChecks.entries()) {
    if (check.implementation !== 'command.v1') continue;
    const rawToolchains = check.parameters?.['toolchainPaths'];
    if (!Array.isArray(rawToolchains)) continue;
    for (const [tIdx, entry] of rawToolchains.entries()) {
      const validated = validateToolchainPath(entry, `/spec/verification/localChecks/${cIdx}/parameters/toolchainPaths/${tIdx}`);
      if (!validated.startsWith('/')) relativeToolchainPaths.push(validated);
    }
  }
  const scriptPlacementProtected = effectiveProtectedPaths(manifestProtected, {
    policyProfile,
    controlRoot,
    manifestPath,
    instructions,
    skills,
    allowWorkflowWrites,
    githubSiblings: options.githubSiblings,
  });
  if (digestsLockfile !== undefined) {
    if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(digestsLockfile, asProtectedSubtreePattern(protectedPath), false))) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `digest lockfile "${digestsLockfile}" must reside inside a protected path`,
        '/spec/execution/digests/lockfile',
      );
    }
  }
  if (preflightScript !== undefined) {
    if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(preflightScript, asProtectedSubtreePattern(protectedPath), false))) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `preflight script "${preflightScript}" must reside inside a protected path`,
        '/spec/preflight/script',
      );
    }
  }
  for (const [index, script] of commandScripts.entries()) {
    if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(script, asProtectedSubtreePattern(protectedPath), false))) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `command.v1 script "${script}" must reside inside a protected path`,
        `/spec/verification/localChecks/${index}/parameters/script`,
      );
    }
  }
  for (const relToolchain of relativeToolchainPaths) {
    if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(relToolchain, asProtectedSubtreePattern(protectedPath), false))) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `command.v1 toolchainPaths entry "${relToolchain}" must reside inside a protected path`,
        '/spec/verification/localChecks',
      );
    }
  }

  const extraProtectedPaths = options.extraProtectedPaths?.map((entry, idx) => (
    normalizeScopePattern(entry, `/extraProtectedPaths/${idx}`)
  ));
  const protectedOptions: EffectiveProtectedPathsOptions = {
    policyProfile,
    controlRoot,
    manifestPath,
    digestsLockfile,
    instructions,
    skills,
    preflightScript,
    commandScripts,
    toolchainPaths: relativeToolchainPaths.length > 0 ? relativeToolchainPaths : undefined,
    proposalPath,
    extraProtectedPaths,
    controlRootSiblings: options.controlRootSiblings,
    priorityControlRootSiblings: options.priorityControlRootSiblings,
    allowWorkflowWrites,
    githubSiblings: options.githubSiblings,
  };
  const { allProtected, mandatoryProtectedSet, explicitWithManifest } = resolveProtectedPathSets(manifestProtected, protectedOptions);
  if (allProtected.length > 128) {
    manifestInvalid('effective protected path set exceeds 128 entries', '/spec/scope/protected');
  }
  assertWritablesDisjointFromProtected(
    writable,
    allProtected,
    mandatoryProtectedSet,
    controlRoot,
    proposalPath,
    policyProfile,
    allowWorkflowWrites,
  );
  if (proposalPath !== undefined) {
    pathInsideWritable(proposalPath, writable, allProtected, '/spec/proposal/path', true, policyProfile, allowWorkflowWrites, manifestProtectedSet);
    if (
      (pathCoveredBy(proposalPath, controlRoot) || pathCoveredByCaseInsensitive(proposalPath, controlRoot))
      && (
        isSingleWildcardWritable
        || !isControlRootProposalWritableAllowed(
          proposalPath,
          writable,
          controlRoot,
          explicitWithManifest,
        )
      )
    ) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `spec.proposal.path "${proposalPath}" inside control root "${controlRoot}" must be listed as an exact file in spec.scope.writable without overlapping protected control-plane paths`,
        '/spec/proposal/path',
      );
    }
    if (!/\.(?:yaml|yml|json)$/i.test(proposalPath)) {
      manifestInvalid('spec.proposal.path must end in .yaml, .yml, or .json', '/spec/proposal/path');
    }
  }
  if (manifest.spec.submission !== undefined) {
    const submissionPath = normalizeRelativePath(manifest.spec.submission.path, '/spec/submission/path');
    pathInsideWritable(submissionPath, writable, allProtected, '/spec/submission/path', false, policyProfile, allowWorkflowWrites, manifestProtectedSet);
  }
  return allProtected;
}

// ---------------------------------------------------------------------------
// TaskpackManifest validator
// ---------------------------------------------------------------------------

function requireObject(value: unknown, path: string, fields: readonly string[]): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) manifestInvalid('expected an object', path);
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) manifestInvalid('expected an object', path);
  const record = value as Record<string, Json>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEYS.has(key) || !fields.includes(key)) manifestInvalid(`unknown field "${key}"`, path);
  }
  return record;
}

function requireString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    manifestInvalid(`expected a string of ${min}..${max} characters`, path);
  }
  if (/[\0\r\n]/.test(value)) manifestInvalid('string contains forbidden control characters', path);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') manifestInvalid('expected a boolean', path);
  return value;
}

function requireIdentifier(value: unknown, path: string): string {
  const text = requireString(value, path, 1, 64);
  if (!IDENTIFIER_PATTERN.test(text)) manifestInvalid('expected a lowercase identifier', path);
  return text;
}

function requireLabel(value: unknown, path: string): string {
  const text = requireString(value, path, 1, 128);
  if (/[\s\p{C}]/u.test(text)) manifestInvalid('expected a 1..128 character non-whitespace label', path);
  return text;
}

function requireStringList(value: unknown, path: string, min: number, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    manifestInvalid(`expected an array of ${min}..${max} items`, path);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const text = requireString(item, `${path}/${index}`, 1, MAX_STRING);
    if (seen.has(text)) manifestInvalid('duplicate list entry', path);
    seen.add(text);
    return text;
  });
}

function requireParameters(value: unknown, path: string): Readonly<Record<string, string | number | boolean | null>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) manifestInvalid('expected an object of scalar parameters', path);
  const record = value as Record<string, Json>;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(record)) {
    if (FORBIDDEN_KEYS.has(key)) manifestInvalid(`forbidden parameter key "${key}"`, path);
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      manifestInvalid('parameter values must be scalars', path);
    }
    if (typeof item === 'string' && item.length > 1024) manifestInvalid('parameter string exceeds 1024 characters', path);
    output[key] = item as string | number | boolean | null;
  }
  return Object.freeze(output);
}

function requireMultilineString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    manifestInvalid(`expected a string of ${min}..${max} characters`, path);
  }
  if (value.includes('\0')) manifestInvalid('string contains forbidden NUL control character', path);
  return value;
}

function pathInsideWritable(
  candidate: string,
  writable: readonly string[],
  protectedPaths: readonly string[],
  path: string,
  legacyPrefixFallback = false,
  policyProfile: PolicyProfile = 'local',
  allowWorkflowWrites = false,
  manifestProtectedSet: ReadonlySet<string> = new Set(),
): void {
  const githubAllowWorkflows = policyProfile === 'github' && allowWorkflowWrites;
  if (writable.length > 0 && !writable.some(root => writableScopeCoversPath(root, candidate, legacyPrefixFallback))) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" is not inside spec.scope.writable`, path);
  }
  if (githubAllowWorkflows && writableEntryOverlapsProtected(candidate, '.github', true, true)) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" overlaps protected path ".github"`, path);
  }
  const overlap = protectedPaths.find(protectedPath => {
    if (
      githubAllowWorkflows
      && !manifestProtectedSet.has(protectedPath)
      && (protectedPath === '.github' || protectedPath === '.github/**')
      && isWorkflowSubpathPattern(candidate)
    ) {
      return false;
    }
    const protectedSubtree = asProtectedSubtreePattern(protectedPath);
    return scopePatternsMayIntersect(candidate, protectedSubtree, false)
      || scopePatternsMayIntersect(candidate, protectedSubtree, true);
  });
  if (overlap !== undefined) {
    throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" overlaps protected path "${overlap}"`, path);
  }
}

const ALLOWED_COMMAND_RUNNER_ENV_NAMES = new Set(['RUNNER_ENVIRONMENT']);
const FORBIDDEN_LITERAL_COMMAND_ENV_NAMES = new Set(['RUNNER_ENVIRONMENT', 'GITHUB_ACTIONS']);

function isReservedCommandEnvName(name: string): boolean {
  if (ALLOWED_COMMAND_RUNNER_ENV_NAMES.has(name)) return false;
  if (RESERVED_COMMAND_ENV_NAMES.has(name)) return true;
  return RESERVED_COMMAND_ENV_PREFIXES.some(prefix => name.startsWith(prefix));
}

function requireSafeIntInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    manifestInvalid(`expected an integer in ${min}..${max}`, path);
  }
  return value;
}

export function validateTaskpackLimitsDeclaration(value: unknown, path: string): TaskpackLimitsDeclaration {
  const raw = requireObject(value, path, [
    'wallTimeSeconds', 'totalTokens', 'contextWindow', 'maxOutputTokens',
    'maxModelCalls', 'maxTurns', 'maxRepairTurns', 'maxAttempts', 'maxFormatRepairs', 'maxImplementationRepairs', 'maxTransportRetries',
    'toolTimeoutSeconds', 'commandTimeoutSeconds', 'responseBytes', 'toolResultBytes',
    'toolArgsBytes', 'promptBytes', 'maxRequestBytes', 'workingWindowBytes', 'fileBytes',
    'sessionBytes', 'candidateEntries', 'overlay',
  ]);
  const out: Record<string, number | OverlayLimits> = {};
  const setOpt = (key: string, min: number, max: number): void => {
    if (raw[key] !== undefined) {
      out[key] = requireSafeIntInRange(raw[key], `${path}/${key}`, min, max);
    }
  };
  setOpt('wallTimeSeconds', 60, 21_600);
  setOpt('totalTokens', 1_000, 1_000_000_000);
  setOpt('contextWindow', 1_024, 10_000_000);
  setOpt('maxOutputTokens', 256, 262_144);
  setOpt('maxModelCalls', 1, 1_024);
  setOpt('maxTurns', 1, 1_024);
  setOpt('maxRepairTurns', 1, 1_024);
  setOpt('maxAttempts', 1, 16);
  setOpt('maxFormatRepairs', 0, 1_024);
  setOpt('maxImplementationRepairs', 0, 1_024);
  setOpt('maxTransportRetries', 0, 8);
  setOpt('toolTimeoutSeconds', 1, 1_800);
  setOpt('commandTimeoutSeconds', 1, 3_600);
  setOpt('responseBytes', 65_536, 67_108_864);
  setOpt('toolResultBytes', 16_384, 4_194_304);
  setOpt('toolArgsBytes', 16_384, 4_194_304);
  setOpt('promptBytes', 4_096, 1_048_576);
  setOpt('maxRequestBytes', 65_536, 16_777_216);
  setOpt('workingWindowBytes', 131_072, 16_777_216);
  setOpt('fileBytes', 65_536, OVERLAY_LIMITS.maxMaxBytes);
  setOpt('sessionBytes', 524_288, 67_108_864);
  setOpt('candidateEntries', 16, OVERLAY_LIMITS.maxMaxFiles);
  if (raw['overlay'] !== undefined) {
    requireObject(raw['overlay'], `${path}/overlay`, ['maxFiles', 'maxBytes']);
    const resolved = resolveOverlayLimits(raw['overlay']);
    if (!resolved.ok) {
      manifestInvalid(`invalid limits.overlay: ${resolved.errors[0]?.code ?? 'VALUE_RANGE'}`, `${path}/overlay`);
    }
    out['overlay'] = Object.freeze({ maxFiles: resolved.value.maxFiles, maxBytes: resolved.value.maxBytes });
  }
  return Object.freeze(out) as TaskpackLimitsDeclaration;
}

export interface ValidateMcpServersOptions {
  readonly allowLoopbackHttp?: boolean | undefined;
}

export function validateMcpServerDeclarations(
  value: unknown,
  path: string,
  options: ValidateMcpServersOptions = {},
): readonly TaskpackMcpServerDeclaration[] {
  if (!Array.isArray(value) || value.length > 16) {
    manifestInvalid('mcp.servers must be an array of 0..16 server declarations', path);
  }
  const seenIds = new Set<string>();
  const servers: TaskpackMcpServerDeclaration[] = [];

  for (const [idx, item] of value.entries()) {
    const serverPath = `${path}/${idx}`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      manifestInvalid('expected an MCP server declaration object', serverPath);
    }
    const rawAny = item as Record<string, unknown>;
    if (rawAny['oauth'] !== undefined) {
      throw new TaskpackError('MCP_OAUTH_UNSUPPORTED', 'MCP OAuth authentication is unsupported', `${serverPath}/oauth`);
    }
    if (rawAny['auth'] !== undefined && rawAny['auth'] !== null && typeof rawAny['auth'] === 'object') {
      const authType = (rawAny['auth'] as Record<string, unknown>)['type'];
      if (typeof authType === 'string' && authType.trim().toLowerCase() === 'oauth') {
        throw new TaskpackError('MCP_OAUTH_UNSUPPORTED', 'MCP OAuth authentication is unsupported', `${serverPath}/auth`);
      }
    }
    const transportRaw = rawAny['transport'];
    if (transportRaw !== 'stdio' && transportRaw !== 'http') {
      manifestInvalid('mcp server transport must be "stdio" or "http"', `${serverPath}/transport`);
    }
    const serverId = requireString(rawAny['id'], `${serverPath}/id`, 1, 24);
    if (!MCP_SERVER_ID_PATTERN.test(serverId) || serverId === 'workspace') {
      manifestInvalid('mcp server id must match ^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$ and must not be "workspace"', `${serverPath}/id`);
    }
    if (seenIds.has(serverId)) {
      manifestInvalid(`duplicate mcp server id "${serverId}"`, `${serverPath}/id`);
    }
    seenIds.add(serverId);

    if (transportRaw === 'stdio') {
      const raw = requireObject(item, serverPath, [
        'id', 'transport', 'command', 'args', 'env', 'envFrom', 'timeoutSeconds', 'includeTools', 'readOnly', 'required',
      ]);
      const command = requireString(raw['command'], `${serverPath}/command`, 1, 512);
      const isBareCommand = !command.includes('/') && !command.includes('\\');
      const isAbsoluteCommand = command.startsWith('/') && !command.includes('..') && !command.includes('\\');
      if (!isBareCommand && !isAbsoluteCommand) {
        manifestInvalid('stdio mcp command must be a bare executable name on PATH or an absolute path', `${serverPath}/command`);
      }
      let args: readonly string[] | undefined;
      if (raw['args'] !== undefined) {
        if (!Array.isArray(raw['args']) || raw['args'].length > 64) {
          manifestInvalid('stdio mcp args must be an array of 0..64 strings', `${serverPath}/args`);
        }
        args = Object.freeze(raw['args'].map((arg, aIdx) => requireString(arg, `${serverPath}/args/${aIdx}`, 0, 1024)));
      }
      let env: Readonly<Record<string, string>> | undefined;
      if (raw['env'] !== undefined) {
        if (raw['env'] === null || typeof raw['env'] !== 'object' || Array.isArray(raw['env'])) {
          manifestInvalid('stdio mcp env must be an object of string entries', `${serverPath}/env`);
        }
        const entries = Object.entries(raw['env'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('stdio mcp env exceeds 32 entries', `${serverPath}/env`);
        const envOut: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (FORBIDDEN_KEYS.has(k) || !COMMAND_ENV_NAME_PATTERN.test(k)) {
            manifestInvalid(`invalid env variable name "${k}"`, `${serverPath}/env/${k}`);
          }
          envOut[k] = requireString(v, `${serverPath}/env/${k}`, 0, 2048);
        }
        env = Object.freeze(envOut);
      }
      let envFrom: Readonly<Record<string, string>> | undefined;
      if (raw['envFrom'] !== undefined) {
        if (raw['envFrom'] === null || typeof raw['envFrom'] !== 'object' || Array.isArray(raw['envFrom'])) {
          manifestInvalid('stdio mcp envFrom must be an object mapping target env names to host env names', `${serverPath}/envFrom`);
        }
        const entries = Object.entries(raw['envFrom'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('stdio mcp envFrom exceeds 32 entries', `${serverPath}/envFrom`);
        const envFromOut: Record<string, string> = {};
        for (const [targetName, sourceName] of entries) {
          if (FORBIDDEN_KEYS.has(targetName) || !COMMAND_ENV_NAME_PATTERN.test(targetName)) {
            manifestInvalid(`invalid target env variable name "${targetName}"`, `${serverPath}/envFrom/${targetName}`);
          }
          const src = requireString(sourceName, `${serverPath}/envFrom/${targetName}`, 1, 64);
          if (!COMMAND_ENV_NAME_PATTERN.test(src) && !/^INPUT_[A-Z0-9_-]{1,63}$/.test(src)) {
            manifestInvalid(`invalid source env variable name "${src}"`, `${serverPath}/envFrom/${targetName}`);
          }
          envFromOut[targetName] = src;
        }
        envFrom = Object.freeze(envFromOut);
      }
      const timeoutSeconds = raw['timeoutSeconds'] === undefined ? undefined : requireSafeIntInRange(raw['timeoutSeconds'], `${serverPath}/timeoutSeconds`, 1, 600);
      const includeTools = raw['includeTools'] === undefined ? undefined : requireStringList(raw['includeTools'], `${serverPath}/includeTools`, 1, 64);
      const readOnly = raw['readOnly'] === undefined ? undefined : requireBoolean(raw['readOnly'], `${serverPath}/readOnly`);
      const required = raw['required'] === undefined ? undefined : requireBoolean(raw['required'], `${serverPath}/required`);
      const decl: TaskpackStdioMcpServerDeclaration = Object.freeze({
        id: serverId,
        transport: 'stdio',
        command,
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env }),
        ...(envFrom === undefined ? {} : { envFrom }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(includeTools === undefined ? {} : { includeTools }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(required === undefined ? {} : { required }),
      });
      servers.push(decl);
    } else {
      const raw = requireObject(item, serverPath, [
        'id', 'transport', 'url', 'headers', 'headersFrom', 'bearerTokenEnv', 'timeoutSeconds', 'includeTools', 'readOnly', 'required',
      ]);
      const urlStr = requireString(raw['url'], `${serverPath}/url`, 1, 2048);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        manifestInvalid('http mcp url is not a valid URL', `${serverPath}/url`);
      }
      if (parsedUrl.username !== '' || parsedUrl.password !== '' || parsedUrl.hash !== '') {
        manifestInvalid('http mcp url must not contain credentials or fragments', `${serverPath}/url`);
      }
      const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '[::1]' || parsedUrl.hostname === 'localhost';
      if (parsedUrl.protocol !== 'https:' && !(options.allowLoopbackHttp === true && parsedUrl.protocol === 'http:' && isLoopback)) {
        manifestInvalid('http mcp url must use https://', `${serverPath}/url`);
      }
      let headers: Readonly<Record<string, string>> | undefined;
      if (raw['headers'] !== undefined) {
        if (raw['headers'] === null || typeof raw['headers'] !== 'object' || Array.isArray(raw['headers'])) {
          manifestInvalid('http mcp headers must be an object of string entries', `${serverPath}/headers`);
        }
        const entries = Object.entries(raw['headers'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('http mcp headers exceeds 32 entries', `${serverPath}/headers`);
        const headersOut: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (FORBIDDEN_KEYS.has(k) || !HTTP_HEADER_NAME_PATTERN.test(k)) {
            manifestInvalid(`invalid header name "${k}"`, `${serverPath}/headers/${k}`);
          }
          if (k.toLowerCase() === 'authorization') {
            manifestInvalid('use bearerTokenEnv or headersFrom instead of literal authorization header', `${serverPath}/headers/${k}`);
          }
          headersOut[k] = requireString(v, `${serverPath}/headers/${k}`, 0, 2048);
        }
        headers = Object.freeze(headersOut);
      }
      let headersFrom: Readonly<Record<string, string>> | undefined;
      if (raw['headersFrom'] !== undefined) {
        if (raw['headersFrom'] === null || typeof raw['headersFrom'] !== 'object' || Array.isArray(raw['headersFrom'])) {
          manifestInvalid('http mcp headersFrom must be an object mapping header names to host env names', `${serverPath}/headersFrom`);
        }
        const entries = Object.entries(raw['headersFrom'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('http mcp headersFrom exceeds 32 entries', `${serverPath}/headersFrom`);
        const headersFromOut: Record<string, string> = {};
        for (const [headerName, sourceName] of entries) {
          if (FORBIDDEN_KEYS.has(headerName) || !HTTP_HEADER_NAME_PATTERN.test(headerName)) {
            manifestInvalid(`invalid header name "${headerName}"`, `${serverPath}/headersFrom/${headerName}`);
          }
          const src = requireString(sourceName, `${serverPath}/headersFrom/${headerName}`, 1, 64);
          if (!COMMAND_ENV_NAME_PATTERN.test(src) && !/^INPUT_[A-Z0-9_-]{1,63}$/.test(src)) {
            manifestInvalid(`invalid source env variable name "${src}"`, `${serverPath}/headersFrom/${headerName}`);
          }
          headersFromOut[headerName] = src;
        }
        headersFrom = Object.freeze(headersFromOut);
      }
      let bearerTokenEnv: string | undefined;
      if (raw['bearerTokenEnv'] !== undefined) {
        const src = requireString(raw['bearerTokenEnv'], `${serverPath}/bearerTokenEnv`, 1, 64);
        if (!COMMAND_ENV_NAME_PATTERN.test(src) && !/^INPUT_[A-Z0-9_-]{1,63}$/.test(src)) {
          manifestInvalid(`invalid bearerTokenEnv "${src}"`, `${serverPath}/bearerTokenEnv`);
        }
        bearerTokenEnv = src;
      }
      const timeoutSeconds = raw['timeoutSeconds'] === undefined ? undefined : requireSafeIntInRange(raw['timeoutSeconds'], `${serverPath}/timeoutSeconds`, 1, 600);
      const includeTools = raw['includeTools'] === undefined ? undefined : requireStringList(raw['includeTools'], `${serverPath}/includeTools`, 1, 64);
      const readOnly = raw['readOnly'] === undefined ? undefined : requireBoolean(raw['readOnly'], `${serverPath}/readOnly`);
      const required = raw['required'] === undefined ? undefined : requireBoolean(raw['required'], `${serverPath}/required`);
      const decl: TaskpackHttpMcpServerDeclaration = Object.freeze({
        id: serverId,
        transport: 'http',
        url: urlStr,
        ...(headers === undefined ? {} : { headers }),
        ...(headersFrom === undefined ? {} : { headersFrom }),
        ...(bearerTokenEnv === undefined ? {} : { bearerTokenEnv }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(includeTools === undefined ? {} : { includeTools }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(required === undefined ? {} : { required }),
      });
      servers.push(decl);
    }
  }
  return Object.freeze(servers);
}

export function collectMcpReferencedEnvNames(servers: readonly TaskpackMcpServerDeclaration[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  if (!servers) return names;
  for (const server of servers) {
    if (server.transport === 'stdio' && server.envFrom !== undefined) {
      for (const src of Object.values(server.envFrom)) names.add(src);
    } else if (server.transport === 'http') {
      if (server.headersFrom !== undefined) {
        for (const src of Object.values(server.headersFrom)) names.add(src);
      }
      if (server.bearerTokenEnv !== undefined) {
        names.add(server.bearerTokenEnv);
      }
    }
  }
  return names;
}

export interface ValidateTaskpackManifestOptions {
  readonly policyProfile?: PolicyProfile | undefined;
  readonly requireDeclaredTrigger?: boolean | undefined;
  readonly controlRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly executionMode?: 'pi' | 'delegated' | undefined;
  readonly allowLoopbackHttp?: boolean | undefined;
  readonly hostPolicy?: ExecutionHostPolicy | undefined;
  readonly enforceHostAuthority?: boolean | undefined;
  readonly githubSiblings?: readonly string[] | undefined;
  readonly extraProtectedPaths?: readonly string[] | undefined;
}

/**
 * Validate a non-root RFC 6901 JSON Pointer (`1..256` chars, `1..32` segments),
 * decode `~1` (`/`) and `~0` (`~`), and reject prototype-chain segments (`__proto__`, `constructor`, `prototype`).
 */
export function validateRfc6901JsonPointer(value: unknown, path: string): readonly string[] {
  const text = requireString(value, path, 1, 256);
  const rfc6901PointerPattern = /^(?:\/(?:[^~/]|~[01])*)+$/;
  if (!rfc6901PointerPattern.test(text)) {
    manifestInvalid(`invalid RFC 6901 JSON Pointer "${text}"`, path);
  }
  const rawSegments = text.slice(1).split('/');
  if (rawSegments.length < 1 || rawSegments.length > 32) {
    manifestInvalid('RFC 6901 JSON Pointer must contain 1..32 segments', path);
  }
  const decodedSegments = rawSegments.map(seg => {
    const decoded = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (FORBIDDEN_KEYS.has(decoded)) {
      manifestInvalid(`RFC 6901 JSON Pointer must not reference forbidden property "${decoded}"`, path);
    }
    return decoded;
  });
  return Object.freeze(decodedSegments);
}

/**
 * True when two `headBranchPrefix` values on the same `targetBranch` collide (either one is a
 * string prefix of the other or one stripped Git ref path covers the other).
 */
export function headBranchPrefixesCollide(prefixA: string, prefixB: string): boolean {
  if (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)) {
    return true;
  }
  const stripA = prefixA.replace(/\/+$/, '');
  const stripB = prefixB.replace(/\/+$/, '');
  return stripA.length === 0 || stripB.length === 0 || pathCoveredBy(stripA, stripB) || pathCoveredBy(stripB, stripA);
}

/** True when a `writable` scope pattern could overlap a mandatory protected path or subtree. */
export function writableOverlapsMandatoryProtected(
  writablePattern: string,
  protectedEntry: string,
  allowWorkflowWrites = false,
  isBuiltInProtected = false,
): boolean {
  return writableEntryOverlapsProtected(writablePattern, protectedEntry, allowWorkflowWrites, isBuiltInProtected);
}

export interface ManifestControlPlanePathsSummary {
  readonly controlRoot: string;
  readonly manifestPath?: string | undefined;
  readonly carvedOutProposalPath?: string | undefined;
  readonly explicitWithoutControlRoot: readonly string[];
  readonly compactMandatoryPaths: readonly string[];
}

/**
 * Collect mandatory control-plane paths declared by a validated domain manifest (excluding user
 * `spec.scope.protected` exclusions so peer domains can still own disjoint writable trees).
 */
export function collectManifestControlPlanePaths(
  manifest: TaskpackManifest | TaskpackV2Manifest,
  options: EffectiveProtectedPathsOptions = {},
): ManifestControlPlanePathsSummary {
  const policyProfile = resolvePolicyProfile(options.policyProfile, undefined);
  const controlRoot = options.controlRoot ?? manifest.controlRoot ?? '.loopwright';
  const manifestPath = options.manifestPath ?? manifest.manifestPath;
  const allowWorkflowWrites = policyProfile === 'github' && options.allowWorkflowWrites === true;
  const instructions = options.instructions ?? [
    ...(manifest.spec.instructions ?? []),
    ...(manifest.spec.roles ?? []).flatMap(role => role.instructions ?? []),
  ];
  const skills = options.skills ?? [
    ...(manifest.spec.skills ?? []),
    ...(manifest.spec.roles ?? []).flatMap(role => role.skills ?? []),
  ];
  const preflightScript = options.preflightScript ?? manifest.spec.preflight?.script;
  const digestsLockfile = options.digestsLockfile ?? manifest.spec.execution?.digests.lockfile;
  const commandScripts = options.commandScripts ?? manifest.spec.verification.localChecks
    .filter(c => c.implementation === 'command.v1')
    .map(c => c.parameters?.['script'])
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  const toolchainPaths = options.toolchainPaths ?? manifest.spec.verification.localChecks
    .flatMap(c => (
      c.implementation === 'command.v1' && Array.isArray(c.parameters?.['toolchainPaths'])
        ? c.parameters['toolchainPaths'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && !entry.startsWith('/'))
        : []
    ));
  const proposalPath = options.proposalPath ?? manifest.spec.proposal?.path;
  const effectiveOpts: EffectiveProtectedPathsOptions = {
    ...options,
    policyProfile,
    controlRoot,
    manifestPath,
    digestsLockfile,
    instructions: instructions.length > 0 ? instructions : undefined,
    skills: skills.length > 0 ? skills : undefined,
    preflightScript,
    commandScripts: commandScripts.length > 0 ? commandScripts : undefined,
    toolchainPaths: toolchainPaths.length > 0 ? toolchainPaths : undefined,
    proposalPath,
    allowWorkflowWrites,
  };
  const explicitWithManifest = explicitProtectedPathsWithoutControlRoot(manifest.spec.scope.protected, effectiveOpts);
  const explicitWithoutControlRoot = explicitProtectedPathsWithoutControlRoot([], effectiveOpts);
  const carvedOut = canCarveOutControlRootProposal(proposalPath, controlRoot, explicitWithManifest)
    && isControlRootProposalWritableAllowed(proposalPath, manifest.spec.scope.writable, controlRoot, explicitWithManifest);

  const compact = new Set<string>([
    ...automationPathsFor(policyProfile, allowWorkflowWrites),
    controlRoot,
  ]);
  if (manifestPath !== undefined) compact.add(manifestPath);
  if (digestsLockfile !== undefined && !pathCoveredBy(digestsLockfile, controlRoot)) {
    compact.add(digestsLockfile);
  }
  for (const instruction of instructions) compact.add(instruction);
  for (const skill of skills) compact.add(skill);
  if (preflightScript !== undefined && !pathCoveredBy(preflightScript, controlRoot)) {
    compact.add(preflightScript);
  }
  for (const script of commandScripts) {
    if (!pathCoveredBy(script, controlRoot)) compact.add(script);
    const parentDir = commandScriptOutsideParentDir(script, controlRoot);
    if (parentDir !== undefined) compact.add(parentDir);
  }
  for (const entry of toolchainPaths) {
    if (!entry.startsWith('/') && !pathCoveredBy(entry, controlRoot)) compact.add(entry);
  }
  if (policyProfile === 'github' && allowWorkflowWrites && options.githubSiblings !== undefined) {
    for (const sibling of options.githubSiblings) {
      if (!isWorkflowSubpathCaseInsensitive(sibling)) compact.add(sibling);
    }
  }

  return Object.freeze({
    controlRoot,
    ...(manifestPath !== undefined ? { manifestPath } : {}),
    ...(carvedOut && proposalPath !== undefined ? { carvedOutProposalPath: proposalPath } : {}),
    explicitWithoutControlRoot,
    compactMandatoryPaths: Object.freeze([...compact]),
  });
}

function isValidCredentialRef(value: string): boolean {
  return value.length <= 64 && (IDENTIFIER_PATTERN.test(value) || COMMAND_ENV_NAME_PATTERN.test(value));
}

function validateRelativePathOrList(
  value: unknown,
  path: string,
): readonly string[] {
  if (typeof value === 'string') {
    return Object.freeze([normalizeRelativePath(value, path)]);
  }
  return Object.freeze(
    requireStringList(value, path, 1, 16)
      .map((entry, idx) => normalizeRelativePath(entry, `${path}/${idx}`)),
  );
}

function validateToolchainPath(value: unknown, path: string): string {
  const text = requireString(value, path, 1, 512);
  if (text !== text.trim()) {
    manifestInvalid('toolchainPaths entry must not have leading or trailing whitespace', path);
  }
  if (text.includes(':') || text.includes('\\')) {
    manifestInvalid('toolchainPaths entry must not contain ":" or "\\"', path);
  }
  if (text.startsWith('/')) {
    if (text === '/') {
      manifestInvalid('toolchainPaths entry must not be root "/"', path);
    }
    const segments = text.slice(1).split('/');
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') {
        manifestInvalid(`toolchainPaths entry "${text}" contains forbidden segment "${segment}"`, path);
      }
    }
    return text;
  }
  return normalizeRelativePath(text, path);
}

function validateVersionPath(value: unknown, path: string): string {
  const text = requireString(value, path, 1, 256);
  if (!VERSION_PATH_PATTERN.test(text)) {
    manifestInvalid(`invalid versionPath selector "${text}"`, path);
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    const segRe = new RegExp(`(?:^|[.\\['"])${forbidden}(?:$|[.\\]'"])`);
    if (segRe.test(text)) {
      manifestInvalid(`versionPath must not reference forbidden property "${forbidden}"`, path);
    }
  }
  return text;
}

function validateExecutionSection(
  rawExecution: unknown,
  controlRoot: string,
): TaskpackExecutionDeclaration {
  const exec = requireObject(rawExecution, '/spec/execution', ['mode', 'capabilities', 'digests']);
  let mode: TaskpackExecutionMode = 'strict';
  if (exec['mode'] !== undefined) {
    const modeStr = requireString(exec['mode'], '/spec/execution/mode', 1, 16);
    if (modeStr !== 'strict' && modeStr !== 'privileged') {
      manifestInvalid('spec.execution.mode must be "strict" or "privileged"', '/spec/execution/mode');
    }
    mode = modeStr;
  }
  const overrides: {
    allowHostEnv?: boolean;
    allowHostPath?: boolean;
    mountReadOnlyGit?: boolean;
    allowCheckNetwork?: boolean;
    allowWorkflowWrites?: boolean;
    allowAgentNetwork?: boolean;
  } = {};
  if (exec['capabilities'] !== undefined) {
    const rawCaps = requireObject(exec['capabilities'], '/spec/execution/capabilities', [
      'allowHostEnv', 'allowHostPath', 'mountReadOnlyGit',
      'allowCheckNetwork', 'allowWorkflowWrites', 'allowAgentNetwork',
    ]);
    if (rawCaps['allowHostEnv'] !== undefined) overrides.allowHostEnv = requireBoolean(rawCaps['allowHostEnv'], '/spec/execution/capabilities/allowHostEnv');
    if (rawCaps['allowHostPath'] !== undefined) overrides.allowHostPath = requireBoolean(rawCaps['allowHostPath'], '/spec/execution/capabilities/allowHostPath');
    if (rawCaps['mountReadOnlyGit'] !== undefined) overrides.mountReadOnlyGit = requireBoolean(rawCaps['mountReadOnlyGit'], '/spec/execution/capabilities/mountReadOnlyGit');
    if (rawCaps['allowCheckNetwork'] !== undefined) overrides.allowCheckNetwork = requireBoolean(rawCaps['allowCheckNetwork'], '/spec/execution/capabilities/allowCheckNetwork');
    if (rawCaps['allowWorkflowWrites'] !== undefined) overrides.allowWorkflowWrites = requireBoolean(rawCaps['allowWorkflowWrites'], '/spec/execution/capabilities/allowWorkflowWrites');
    if (rawCaps['allowAgentNetwork'] !== undefined) overrides.allowAgentNetwork = requireBoolean(rawCaps['allowAgentNetwork'], '/spec/execution/capabilities/allowAgentNetwork');
  }
  const capabilities = resolveExecutionCapabilities(mode, overrides);

  let pinDigests = false;
  let lockfile: string | undefined;
  if (exec['digests'] !== undefined) {
    const rawDigests = requireObject(exec['digests'], '/spec/execution/digests', ['pinDigests', 'lockfile']);
    if (rawDigests['pinDigests'] !== undefined) {
      pinDigests = requireBoolean(rawDigests['pinDigests'], '/spec/execution/digests/pinDigests');
    }
    if (rawDigests['lockfile'] !== undefined) {
      lockfile = normalizeRelativePath(rawDigests['lockfile'], '/spec/execution/digests/lockfile');
    }
  }
  if (pinDigests && lockfile === undefined) {
    lockfile = `${controlRoot}/digests.lock.json`;
  }
  const digests: TaskpackExecutionDigestsDeclaration = Object.freeze({
    pinDigests,
    ...(lockfile === undefined ? {} : { lockfile }),
  });
  return Object.freeze({ mode, capabilities, digests });
}

function validateStepsDag(
  rawSteps: unknown,
  roleById: ReadonlyMap<string, TaskpackRoleDeclaration>,
  checkIds: ReadonlySet<string>,
  executionMode: 'pi' | 'delegated' | undefined,
): readonly TaskpackStepDeclaration[] {
  if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > MAX_TASKPACK_STEPS) {
    manifestInvalid(`spec.steps must contain 1..${MAX_TASKPACK_STEPS} entries`, '/spec/steps');
  }
  const reservedStepIds = new Set(['controller.scope', 'controller.no-change']);
  const stepIds = new Set<string>();
  const steps: TaskpackStepDeclaration[] = [];

  for (const [idx, item] of rawSteps.entries()) {
    const sPath = `/spec/steps/${idx}`;
    const rawStep = requireObject(item, sPath, ['id', 'kind', 'role', 'check', 'dependsOn', 'onRework']);
    const id = requireIdentifier(rawStep['id'], `${sPath}/id`);
    if (stepIds.has(id)) manifestInvalid(`duplicate step id "${id}"`, `${sPath}/id`);
    if (reservedStepIds.has(id)) manifestInvalid(`step id "${id}" is reserved`, `${sPath}/id`);
    stepIds.add(id);

    const kindStr = requireString(rawStep['kind'], `${sPath}/kind`, 1, 16);
    if (kindStr !== 'agent' && kindStr !== 'check' && kindStr !== 'compact') {
      manifestInvalid('step kind must be "agent", "check", or "compact"', `${sPath}/kind`);
    }
    const kind: TaskpackStepKind = kindStr;

    let role: string | undefined;
    let check: string | undefined;
    if (kind === 'agent' || kind === 'compact') {
      if (rawStep['check'] !== undefined) {
        manifestInvalid(`step "${id}" of kind "${kind}" must not specify "check"`, `${sPath}/check`);
      }
      role = requireIdentifier(rawStep['role'], `${sPath}/role`);
      const declaredRole = roleById.get(role);
      if (declaredRole === undefined) {
        manifestInvalid(`step "${id}" references unknown role "${role}"`, `${sPath}/role`);
      }
      if (kind === 'compact') {
        if (executionMode === 'delegated' || declaredRole.provider === 'delegated') {
          manifestInvalid(
            `compact step "${id}" cannot target delegated role "${role}"`,
            `${sPath}/role`,
          );
        }
      }
    } else {
      if (rawStep['role'] !== undefined) {
        manifestInvalid(`check step "${id}" must not specify "role"`, `${sPath}/role`);
      }
      check = requireIdentifier(rawStep['check'], `${sPath}/check`);
      if (!checkIds.has(check)) {
        manifestInvalid(`check step "${id}" references unknown check "${check}"`, `${sPath}/check`);
      }
    }

    let dependsOn: readonly string[] = Object.freeze([]);
    if (rawStep['dependsOn'] !== undefined) {
      const deps = requireStringList(rawStep['dependsOn'], `${sPath}/dependsOn`, 0, MAX_TASKPACK_STEPS - 1);
      for (const [dIdx, depId] of deps.entries()) {
        requireIdentifier(depId, `${sPath}/dependsOn/${dIdx}`);
      }
      dependsOn = Object.freeze([...deps]);
    }

    let onRework: ReworkPolicy | undefined;
    if (rawStep['onRework'] !== undefined) {
      if (kind === 'compact') {
        manifestInvalid(`compact step "${id}" must not declare onRework`, `${sPath}/onRework`);
      }
      const rawRework = requireObject(rawStep['onRework'], `${sPath}/onRework`, ['rejectTo', 'maxReworks']);
      const rejectTo = requireIdentifier(rawRework['rejectTo'], `${sPath}/onRework/rejectTo`);
      const maxReworks = requireSafeIntInRange(
        rawRework['maxReworks'],
        `${sPath}/onRework/maxReworks`,
        1,
        Math.min(MAX_STEP_REWORKS, LIMITS.maxReworks),
      );
      onRework = Object.freeze({ rejectTo, maxReworks });
    }

    steps.push(Object.freeze({
      id,
      kind,
      ...(role === undefined ? {} : { role }),
      ...(check === undefined ? {} : { check }),
      dependsOn,
      ...(onRework === undefined ? {} : { onRework }),
    }));
  }

  const stepById = new Map<string, TaskpackStepDeclaration>(steps.map(s => [s.id, s]));
  for (const [idx, step] of steps.entries()) {
    for (const [dIdx, depId] of step.dependsOn.entries()) {
      if (!stepById.has(depId)) {
        manifestInvalid(`step "${step.id}" dependsOn unknown step "${depId}"`, `/spec/steps/${idx}/dependsOn/${dIdx}`);
      }
      if (depId === step.id) {
        manifestInvalid(`step "${step.id}" cannot depend on itself`, `/spec/steps/${idx}/dependsOn/${dIdx}`);
      }
    }
    if (step.onRework !== undefined && !stepById.has(step.onRework.rejectTo)) {
      manifestInvalid(`step "${step.id}" onRework.rejectTo references unknown step "${step.onRework.rejectTo}"`, `/spec/steps/${idx}/onRework/rejectTo`);
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  const dfsCycle = (id: string): void => {
    const cur = state.get(id) ?? 0;
    if (cur === 2) return;
    if (cur === 1) {
      manifestInvalid(`spec.steps contains a dependency cycle involving "${id}"`, '/spec/steps');
    }
    state.set(id, 1);
    const node = stepById.get(id)!;
    for (const dep of node.dependsOn) {
      dfsCycle(dep);
    }
    state.set(id, 2);
  };
  for (const step of steps) dfsCycle(step.id);

  const strictAncestors = (startId: string): ReadonlySet<string> => {
    const visited = new Set<string>();
    const stack = [...stepById.get(startId)!.dependsOn];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const parent of stepById.get(current)!.dependsOn) {
        stack.push(parent);
      }
    }
    return visited;
  };

  for (const [idx, step] of steps.entries()) {
    if (step.onRework !== undefined) {
      const ancestors = strictAncestors(step.id);
      if (!ancestors.has(step.onRework.rejectTo)) {
        manifestInvalid(
          `step "${step.id}" onRework.rejectTo "${step.onRework.rejectTo}" must be a strict ancestor in spec.steps`,
          `/spec/steps/${idx}/onRework/rejectTo`,
        );
      }
      const targetStep = stepById.get(step.onRework.rejectTo)!;
      const targetRole = targetStep.role !== undefined ? roleById.get(targetStep.role) : undefined;
      if (targetStep.kind !== 'agent' || targetRole?.purpose !== 'task') {
        manifestInvalid(
          `step "${step.id}" onRework.rejectTo "${step.onRework.rejectTo}" must target an agent step with role purpose "task"`,
          `/spec/steps/${idx}/onRework/rejectTo`,
        );
      }
    }
    if (step.kind === 'compact') {
      const ancestors = strictAncestors(step.id);
      const sameRoleAgents = steps.filter(
        candidate => ancestors.has(candidate.id) && candidate.kind === 'agent' && candidate.role === step.role,
      );
      const maximal = sameRoleAgents.filter(candidate => !sameRoleAgents.some(
        other => other.id !== candidate.id && strictAncestors(other.id).has(candidate.id),
      ));
      if (maximal.length !== 1) {
        manifestInvalid(
          `compact step "${step.id}" must have exactly one maximal ancestor agent step for role "${step.role}" (found ${maximal.length})`,
          `/spec/steps/${idx}`,
        );
      }
    }
  }

  return Object.freeze(steps);
}

function validateTaskpackManifestInternal(
  value: Json,
  options: ValidateTaskpackManifestOptions,
  schemaMode: 'v1-compat' | 'v2',
): TaskpackV2Manifest {
  const policyProfile = resolvePolicyProfile(options.policyProfile, options.hostPolicy?.policyProfile);
  const controlRoot = options.controlRoot !== undefined ? normalizeRelativePath(options.controlRoot, '/') : '.loopwright';
  const manifestPath = options.manifestPath !== undefined ? normalizeRelativePath(options.manifestPath, '/') : undefined;
  const rawRoot = requireObject(value, '/', ['apiVersion', 'kind', 'metadata', 'spec']);
  if (rawRoot['apiVersion'] !== TASKPACK_MANIFEST_API_VERSION) manifestInvalid('unsupported apiVersion', '/apiVersion');
  if (rawRoot['kind'] !== 'Taskpack') manifestInvalid('kind must be Taskpack', '/kind');

  const rawSpecBeforeInterp = requireObject(rawRoot['spec'], '/spec', [
    'goal', 'scope', 'instructions', 'skills', 'execution', 'preflight', 'vars', 'target',
    'upstreams', 'upstreamGroups', 'proposal', 'submission', 'verification',
    'publication', 'memory', 'triggers', 'sandbox', 'decisions', 'models', 'mcp', 'limits', 'roles', 'steps', 'output',
  ]);
  const vars: Readonly<Record<string, string>> | undefined = rawSpecBeforeInterp['vars'] === undefined
    ? undefined
    : validateSpecVarsRecord(rawSpecBeforeInterp['vars'], '/spec/vars');
  const activeVars: Readonly<Record<string, string>> = vars ?? Object.freeze(Object.create(null) as Record<string, string>);
  const interpolatedRoot = walkAstForInterpolation(rawRoot, activeVars, '', true, vars !== undefined) as Record<string, Json>;

  const metadata = requireObject(interpolatedRoot['metadata'], '/metadata', ['name']);
  const name = requireIdentifier(metadata['name'], '/metadata/name');
  const spec = interpolatedRoot['spec'] as Record<string, Json>;

  const hasExplicitExecution = spec['execution'] !== undefined;
  const resolvedExecution: TaskpackExecutionDeclaration = hasExplicitExecution
    ? validateExecutionSection(spec['execution'], controlRoot)
    : Object.freeze({
      mode: 'strict' as const,
      capabilities: resolveExecutionCapabilities('strict'),
      digests: Object.freeze({ pinDigests: false }),
    });
  if (options.enforceHostAuthority !== false) {
    validateExecutionAuthority(resolvedExecution, options.hostPolicy);
  }
  const allowWorkflowWrites = (
    policyProfile === 'github'
    && resolvedExecution.capabilities.allowWorkflowWrites
    && (options.enforceHostAuthority === false || options.hostPolicy?.allowWorkflowWrites === true)
  );
  const digestsLockfile = resolvedExecution.digests.lockfile;

  const limits: TaskpackLimitsDeclaration | undefined = spec['limits'] === undefined
    ? undefined
    : validateTaskpackLimitsDeclaration(spec['limits'], '/spec/limits');
  const goal = requireObject(spec['goal'], '/spec/goal', ['candidate', 'noChange']);
  const goalCandidate = requireString(goal['candidate'], '/spec/goal/candidate', 1, 1024);
  const goalNoChange = requireString(goal['noChange'], '/spec/goal/noChange', 1, 1024);

  const instructions = spec['instructions'] === undefined
    ? undefined
    : validateRelativePathOrList(spec['instructions'], '/spec/instructions');
  const skills = spec['skills'] === undefined
    ? undefined
    : validateRelativePathOrList(spec['skills'], '/spec/skills');

  let writable: readonly string[] = [];
  let manifestProtected: readonly string[] = [];
  if (spec['scope'] !== undefined) {
    const scope = requireObject(spec['scope'], '/spec/scope', ['writable', 'protected']);
    if (scope['writable'] !== undefined) {
      writable = requireStringList(scope['writable'], '/spec/scope/writable', 1, 128)
        .map((entry, index) => normalizeScopePattern(entry, `/spec/scope/writable/${index}`));
    }
    if (scope['protected'] !== undefined) {
      manifestProtected = requireStringList(scope['protected'], '/spec/scope/protected', 0, 128)
        .map((entry, index) => normalizeScopePattern(entry, `/spec/scope/protected/${index}`));
    }
  }
  const rawProposalObj = spec['proposal'];
  const candidateProposalPath = (
    rawProposalObj !== null
    && typeof rawProposalObj === 'object'
    && !Array.isArray(rawProposalObj)
    && Object.hasOwn(rawProposalObj, 'path')
  )
    ? tryNormalizeRelativePath((rawProposalObj as Record<string, unknown>)['path'])
    : undefined;
  const scriptPlacementProtected = effectiveProtectedPaths(manifestProtected, {
    policyProfile,
    controlRoot,
    manifestPath,
    instructions,
    skills,
    allowWorkflowWrites,
    githubSiblings: options.githubSiblings,
  });
  if (digestsLockfile !== undefined) {
    if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(digestsLockfile, asProtectedSubtreePattern(protectedPath), false))) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `digest lockfile "${digestsLockfile}" must reside inside a protected path`,
        '/spec/execution/digests/lockfile',
      );
    }
  }

  let preflight: TaskpackPreflightDeclaration | undefined;
  if (spec['preflight'] !== undefined) {
    const rawPre = requireObject(spec['preflight'], '/spec/preflight', ['script', 'timeoutSeconds', 'env']);
    const script = normalizeRelativePath(rawPre['script'], '/spec/preflight/script');
    if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(script, asProtectedSubtreePattern(protectedPath), false))) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `preflight script "${script}" must reside inside a protected path`,
        '/spec/preflight/script',
      );
    }
    const timeoutSeconds = rawPre['timeoutSeconds'] === undefined
      ? undefined
      : requireSafeIntInRange(rawPre['timeoutSeconds'], '/spec/preflight/timeoutSeconds', 1, 3_600);
    let env: readonly string[] | undefined;
    if (rawPre['env'] !== undefined) {
      const rawEnv = requireStringList(rawPre['env'], '/spec/preflight/env', 0, 32);
      for (const [eIdx, envName] of rawEnv.entries()) {
        if (!COMMAND_ENV_NAME_PATTERN.test(envName)) {
          manifestInvalid(`preflight env "${envName}" must match ^[A-Z][A-Z0-9_]{0,63}$`, `/spec/preflight/env/${eIdx}`);
        }
        if (isReservedCommandEnvName(envName)) {
          manifestInvalid(`preflight env "${envName}" is reserved`, `/spec/preflight/env/${eIdx}`);
        }
      }
      env = Object.freeze([...rawEnv]);
    }
    preflight = Object.freeze({
      script,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      ...(env === undefined ? {} : { env }),
    });
  }

  let target: TaskpackTargetDeclaration | undefined;
  if (spec['target'] !== undefined) {
    const rawTarget = requireObject(spec['target'], '/spec/target', ['matrix']);
    if (rawTarget['matrix'] === undefined) {
      target = Object.freeze({});
    } else if (rawTarget['matrix'] === null) {
      target = Object.freeze({ matrix: null });
    } else {
      const rawMatrix = rawTarget['matrix'];
      if (!Array.isArray(rawMatrix) || rawMatrix.length < 1 || rawMatrix.length > LIMITS.targets) {
        manifestInvalid(`spec.target.matrix must contain 1..${LIMITS.targets} cells`, '/spec/target/matrix');
      }
      const seenCellIds = new Set<string>();
      const cells: TargetMatrixCell[] = rawMatrix.map((item, idx) => {
        const cPath = `/spec/target/matrix/${idx}`;
        const rawCell = requireObject(item, cPath, ['id', 'platform', 'variant']);
        const id = requireIdentifier(rawCell['id'], `${cPath}/id`);
        if (seenCellIds.has(id)) manifestInvalid(`duplicate target matrix cell id "${id}"`, `${cPath}/id`);
        seenCellIds.add(id);
        const platform = requireLabel(rawCell['platform'], `${cPath}/platform`);
        const variant = requireLabel(rawCell['variant'], `${cPath}/variant`);
        return Object.freeze({ id, platform, variant });
      });
      target = Object.freeze({ matrix: Object.freeze(cells) });
    }
  }

  const manifestProtectedSet = new Set(manifestProtected);
  const earlyProtected = resolveProtectedPathSets(manifestProtected, {
    policyProfile,
    controlRoot,
    manifestPath,
    digestsLockfile,
    instructions,
    skills,
    preflightScript: preflight?.script,
    proposalPath: candidateProposalPath,
    allowWorkflowWrites,
    githubSiblings: options.githubSiblings,
  });
  const protectedPaths = earlyProtected.allProtected;
  assertWritablesDisjointFromProtected(
    writable,
    protectedPaths,
    earlyProtected.mandatoryProtectedSet,
    controlRoot,
    candidateProposalPath,
    policyProfile,
    allowWorkflowWrites,
  );

  const rawUpstreams = spec['upstreams'];
  const minUpstreams = (schemaMode === 'v2' || preflight !== undefined) ? 0 : 1;
  const upstreamsValue = (schemaMode === 'v2' && rawUpstreams === undefined) ? [] : rawUpstreams;
  if (!Array.isArray(upstreamsValue) || upstreamsValue.length < minUpstreams || upstreamsValue.length > 32) {
    manifestInvalid(`spec.upstreams must contain ${minUpstreams}..32 entries`, '/spec/upstreams');
  }
  const upstreamIds = new Set<string>();
  const upstreams = upstreamsValue.map((item, index) => {
    const uPath = `/spec/upstreams/${index}`;
    const upstream = requireObject(item, uPath, [
      'id', 'kind', 'source', 'watchedPaths', 'allowPrerelease', 'versionPath', 'monotonicSemver',
    ]);
    const upstreamId = requireIdentifier(upstream['id'], `${uPath}/id`);
    if (upstreamIds.has(upstreamId)) manifestInvalid('duplicate upstream id', `${uPath}/id`);
    upstreamIds.add(upstreamId);
    const kindText = requireString(upstream['kind'], `${uPath}/kind`, 1, 32);
    if (!['github-release', 'git-tag', 'git-commit', 'http-json', 'custom-table'].includes(kindText)) {
      manifestInvalid('unsupported upstream kind', `${uPath}/kind`);
    }
    const source = requireString(upstream['source'], `${uPath}/source`, 1, 512);
    const watchedPaths = requireStringList(upstream['watchedPaths'], `${uPath}/watchedPaths`, 0, 64)
      .map((entry, entryIndex) => normalizeRelativePath(entry, `${uPath}/watchedPaths/${entryIndex}`));
    const allowPrerelease = upstream['allowPrerelease'] === undefined
      ? undefined
      : requireBoolean(upstream['allowPrerelease'], `${uPath}/allowPrerelease`);
    let versionPath: string | undefined;
    if (upstream['versionPath'] !== undefined) {
      if (kindText !== 'http-json') {
        manifestInvalid('versionPath is only supported on http-json upstreams', `${uPath}/versionPath`);
      }
      versionPath = validateVersionPath(upstream['versionPath'], `${uPath}/versionPath`);
    }
    let monotonicSemver: boolean | undefined;
    if (upstream['monotonicSemver'] !== undefined) {
      if (kindText !== 'http-json') {
        manifestInvalid('monotonicSemver is only supported on http-json upstreams', `${uPath}/monotonicSemver`);
      }
      monotonicSemver = requireBoolean(upstream['monotonicSemver'], `${uPath}/monotonicSemver`);
    }
    const descriptor: TaskpackUpstreamDescriptor = Object.freeze({
      id: upstreamId,
      kind: kindText as TaskpackUpstreamDescriptor['kind'],
      source,
      watchedPaths,
      ...(allowPrerelease === undefined ? {} : { allowPrerelease }),
      ...(versionPath === undefined ? {} : { versionPath }),
      ...(monotonicSemver === undefined ? {} : { monotonicSemver }),
    });
    return descriptor;
  });

  let upstreamGroups: readonly TaskpackUpstreamGroupDeclaration[] | undefined;
  if (spec['upstreamGroups'] !== undefined) {
    const rawGroups = spec['upstreamGroups'];
    if (!Array.isArray(rawGroups) || rawGroups.length > 32) {
      manifestInvalid('spec.upstreamGroups must contain 0..32 entries', '/spec/upstreamGroups');
    }
    const seenGroupIds = new Set<string>();
    const lockstepMemberOwner = new Map<string, string>();
    const parsedGroups: TaskpackUpstreamGroupDeclaration[] = rawGroups.map((item, idx) => {
      const gPath = `/spec/upstreamGroups/${idx}`;
      const rawGroup = requireObject(item, gPath, ['id', 'members', 'policy']);
      const groupId = requireIdentifier(rawGroup['id'], `${gPath}/id`);
      if (seenGroupIds.has(groupId)) manifestInvalid(`duplicate upstreamGroup id "${groupId}"`, `${gPath}/id`);
      seenGroupIds.add(groupId);
      const policyStr = requireString(rawGroup['policy'], `${gPath}/policy`, 1, 16);
      if (policyStr !== 'lockstep' && policyStr !== 'independent') {
        manifestInvalid('upstreamGroup policy must be "lockstep" or "independent"', `${gPath}/policy`);
      }
      const policy: TaskpackUpstreamGroupPolicy = policyStr;
      const members = requireStringList(rawGroup['members'], `${gPath}/members`, 1, 32);
      for (const [mIdx, memberId] of members.entries()) {
        requireIdentifier(memberId, `${gPath}/members/${mIdx}`);
        if (!upstreamIds.has(memberId)) {
          manifestInvalid(`upstreamGroup "${groupId}" references unknown upstream "${memberId}"`, `${gPath}/members/${mIdx}`);
        }
        if (policy === 'lockstep') {
          const existingOwner = lockstepMemberOwner.get(memberId);
          if (existingOwner !== undefined) {
            manifestInvalid(
              `upstream "${memberId}" cannot belong to multiple lockstep groups ("${existingOwner}" and "${groupId}")`,
              `${gPath}/members/${mIdx}`,
            );
          }
          lockstepMemberOwner.set(memberId, groupId);
        }
      }
      return Object.freeze({ id: groupId, members: Object.freeze([...members]), policy });
    });
    upstreamGroups = Object.freeze(parsedGroups);
  }

  const legacyPrefixFallback = schemaMode === 'v1-compat';

  let proposalDecl: TaskpackProposalDeclaration | undefined;
  let proposalPath: string | undefined;
  if (spec['proposal'] !== undefined || schemaMode === 'v1-compat') {
    const proposal = requireObject(spec['proposal'], '/spec/proposal', ['path', 'requiredFields', 'schemaVersion']);
    proposalPath = normalizeRelativePath(proposal['path'], '/spec/proposal/path');
    pathInsideWritable(proposalPath, writable, protectedPaths, '/spec/proposal/path', legacyPrefixFallback, policyProfile, allowWorkflowWrites, manifestProtectedSet);
    if (
      (pathCoveredBy(proposalPath, controlRoot) || pathCoveredByCaseInsensitive(proposalPath, controlRoot))
      && !isControlRootProposalWritableAllowed(
        proposalPath,
        writable,
        controlRoot,
        earlyProtected.explicitWithManifest,
      )
    ) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `spec.proposal.path "${proposalPath}" inside control root "${controlRoot}" must be listed as an exact file in spec.scope.writable without overlapping protected control-plane paths`,
        '/spec/proposal/path',
      );
    }
    if (!/\.(?:yaml|yml|json)$/i.test(proposalPath)) {
      manifestInvalid('spec.proposal.path must end in .yaml, .yml, or .json', '/spec/proposal/path');
    }
    const requiredFields = requireStringList(proposal['requiredFields'], '/spec/proposal/requiredFields', 1, 32);
    for (const [index, field] of requiredFields.entries()) {
      if (!FIELD_NAME_PATTERN.test(field)) manifestInvalid(`required field "${field}" is not a valid field name`, `/spec/proposal/requiredFields/${index}`);
    }
    const schemaVersion = proposal['schemaVersion'];
    if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
      manifestInvalid('schemaVersion must be a positive integer', '/spec/proposal/schemaVersion');
    }
    proposalDecl = Object.freeze({ path: proposalPath, requiredFields: Object.freeze(requiredFields), schemaVersion });
  }

  let submissionDecl: TaskpackSubmissionDeclaration | undefined;
  if (spec['submission'] !== undefined) {
    const rawSub = requireObject(spec['submission'], '/spec/submission', ['path', 'required']);
    const subPath = normalizeRelativePath(rawSub['path'], '/spec/submission/path');
    if (!/\.json$/i.test(subPath)) {
      manifestInvalid('spec.submission.path must end in .json', '/spec/submission/path');
    }
    pathInsideWritable(subPath, writable, protectedPaths, '/spec/submission/path', legacyPrefixFallback, policyProfile, allowWorkflowWrites, manifestProtectedSet);
    const required = rawSub['required'] === undefined
      ? false
      : requireBoolean(rawSub['required'], '/spec/submission/required');
    submissionDecl = Object.freeze({ path: subPath, required });
  }

  const verification = requireObject(spec['verification'], '/spec/verification', ['localChecks', 'externalGates']);
  const localChecksValue = verification['localChecks'];
  if (!Array.isArray(localChecksValue) || localChecksValue.length > 32) manifestInvalid('spec.verification.localChecks must contain 0..32 entries', '/spec/verification/localChecks');
  const externalGatesValue = verification['externalGates'];
  if (!Array.isArray(externalGatesValue) || externalGatesValue.length > 32) manifestInvalid('spec.verification.externalGates must contain 0..32 entries', '/spec/verification/externalGates');
  const checkIds = new Set<string>();
  const reservedIds = new Set(['scope', 'no-change', 'taskpack-author', 'taskpack-no-change']);
  const allowedLocalCheckImpls = schemaMode === 'v2'
    ? ['json-artifact.v1', 'scope.v1', 'no-change.v1', 'command.v1', 'json-keys-guard.v1', 'line-section-guard.v1']
    : ['json-artifact.v1', 'scope.v1', 'no-change.v1', 'command.v1'];

  const relativeToolchainPaths: string[] = [];
  const localChecks: TaskpackV2CheckDeclaration[] = localChecksValue.map((item, index) => {
    const check = requireObject(item, `/spec/verification/localChecks/${index}`, ['id', 'implementation', 'parameters']);
    const checkId = requireIdentifier(check['id'], `/spec/verification/localChecks/${index}/id`);
    if (checkIds.has(checkId)) manifestInvalid('duplicate check id across localChecks and externalGates', `/spec/verification/localChecks/${index}/id`);
    if (reservedIds.has(checkId)) manifestInvalid(`check id "${checkId}" is reserved by the compiler`, `/spec/verification/localChecks/${index}/id`);
    checkIds.add(checkId);
    const implementation = requireString(check['implementation'], `/spec/verification/localChecks/${index}/implementation`, 1, 32);
    if (!allowedLocalCheckImpls.includes(implementation)) {
      manifestInvalid('unsupported local check implementation', `/spec/verification/localChecks/${index}/implementation`);
    }
    if (implementation === 'command.v1') {
      const paramPath = `/spec/verification/localChecks/${index}/parameters`;
      const params = requireObject(check['parameters'], paramPath, [
        'script', 'args', 'timeoutSeconds', 'allowReadOnlyGitHubToken', 'env',
        'toolchainPaths', 'preserveRepoDirName', 'mountReadOnlyGit', 'networkMode',
      ]);
      const script = normalizeRelativePath(params['script'], `${paramPath}/script`);
      if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(script, asProtectedSubtreePattern(protectedPath), false))) {
        throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `command.v1 script "${script}" must reside inside a protected path`, `${paramPath}/script`);
      }
      let args: readonly string[] | undefined;
      if (params['args'] !== undefined) {
        if (!Array.isArray(params['args']) || params['args'].length > 64) {
          manifestInvalid('command.v1 args must be an array of 0..64 strings', `${paramPath}/args`);
        }
        args = Object.freeze(params['args'].map((arg, aIdx) => requireString(arg, `${paramPath}/args/${aIdx}`, 0, 1024)));
      }
      let explicitTimeoutSeconds: number | undefined;
      if (params['timeoutSeconds'] !== undefined) {
        explicitTimeoutSeconds = requireSafeIntInRange(params['timeoutSeconds'], `${paramPath}/timeoutSeconds`, 1, 3_600);
      }
      const allowReadOnlyGitHubToken = params['allowReadOnlyGitHubToken'] === undefined
        ? false
        : requireBoolean(params['allowReadOnlyGitHubToken'], `${paramPath}/allowReadOnlyGitHubToken`);
      let env: readonly string[] | Readonly<Record<string, string>> = Object.freeze([]);
      if (params['env'] !== undefined) {
        if (Array.isArray(params['env'])) {
          const rawEnv = requireStringList(params['env'], `${paramPath}/env`, 0, 16);
          for (const [envIdx, envName] of rawEnv.entries()) {
            if (!COMMAND_ENV_NAME_PATTERN.test(envName)) {
              manifestInvalid(`command.v1 env "${envName}" must match ^[A-Z][A-Z0-9_]{0,63}$`, `${paramPath}/env/${envIdx}`);
            }
            if (isReservedCommandEnvName(envName)) {
              manifestInvalid(`command.v1 env "${envName}" is reserved`, `${paramPath}/env/${envIdx}`);
            }
          }
          env = Object.freeze([...rawEnv]);
        } else if (isPlainObjectRecord(params['env'])) {
          const entries = Object.entries(params['env']);
          if (entries.length > 32) {
            manifestInvalid('command.v1 env map exceeds 32 entries', `${paramPath}/env`);
          }
          const envMap: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [k, v] of entries) {
            if (FORBIDDEN_KEYS.has(k) || !COMMAND_ENV_NAME_PATTERN.test(k)) {
              manifestInvalid(`command.v1 env "${k}" must match ^[A-Z][A-Z0-9_]{0,63}$`, `${paramPath}/env/${k}`);
            }
            if (isReservedCommandEnvName(k) || FORBIDDEN_LITERAL_COMMAND_ENV_NAMES.has(k)) {
              manifestInvalid(`command.v1 env "${k}" is reserved`, `${paramPath}/env/${k}`);
            }
            envMap[k] = requireString(v, `${paramPath}/env/${k}`, 0, 1024);
          }
          env = Object.freeze(envMap);
        } else {
          manifestInvalid('command.v1 env must be an array of env names or an object of string values', `${paramPath}/env`);
        }
      }
      let toolchainPaths: readonly string[] | undefined;
      if (params['toolchainPaths'] !== undefined) {
        const rawToolchain = requireStringList(params['toolchainPaths'], `${paramPath}/toolchainPaths`, 0, 32);
        toolchainPaths = Object.freeze(rawToolchain.map((entry, tIdx) => {
          const tPath = `${paramPath}/toolchainPaths/${tIdx}`;
          const validated = validateToolchainPath(entry, tPath);
          if (!validated.startsWith('/')) {
            if (!scriptPlacementProtected.some(protectedPath => scopePatternsMayIntersect(validated, asProtectedSubtreePattern(protectedPath), false))) {
              throw new TaskpackError(
                'TASKPACK_SCOPE_VIOLATION',
                `command.v1 toolchainPaths entry "${validated}" must reside inside a protected path`,
                tPath,
              );
            }
            const overlapWritable = writable.find(w => (
              scopePatternsMayIntersect(w, asProtectedSubtreePattern(validated), false)
              || scopePatternsMayIntersect(w, asProtectedSubtreePattern(validated), true)
            ));
            if (overlapWritable !== undefined) {
              throw new TaskpackError(
                'TASKPACK_SCOPE_VIOLATION',
                `command.v1 toolchainPaths entry "${validated}" must not overlap spec.scope.writable "${overlapWritable}"`,
                tPath,
              );
            }
            relativeToolchainPaths.push(validated);
          }
          return validated;
        }));
      }
      const preserveRepoDirName = params['preserveRepoDirName'] === undefined
        ? undefined
        : requireBoolean(params['preserveRepoDirName'], `${paramPath}/preserveRepoDirName`);
      const mountReadOnlyGit = params['mountReadOnlyGit'] === undefined
        ? undefined
        : requireBoolean(params['mountReadOnlyGit'], `${paramPath}/mountReadOnlyGit`);
      if (mountReadOnlyGit === true && options.enforceHostAuthority !== false && options.hostPolicy?.allowPrivileged !== true) {
        throw new TaskpackError(
          'TASKPACK_HOST_BINDING_INVALID',
          'command.v1 parameters.mountReadOnlyGit: true requires operator host authorization (allowPrivileged)',
          `${paramPath}/mountReadOnlyGit`,
        );
      }
      let checkNetworkMode: 'none' | 'loopback-only' | undefined;
      if (params['networkMode'] !== undefined) {
        const nm = requireString(params['networkMode'], `${paramPath}/networkMode`, 1, 32);
        if (nm !== 'none' && nm !== 'loopback-only') {
          manifestInvalid('command.v1 networkMode must be "none" or "loopback-only"', `${paramPath}/networkMode`);
        }
        if (nm === 'loopback-only') {
          if (!resolvedExecution.capabilities.allowCheckNetwork) {
            throw new TaskpackError(
              'TASKPACK_SCOPE_VIOLATION',
              'command.v1 parameters.networkMode: "loopback-only" requires spec.execution.capabilities.allowCheckNetwork: true',
              `${paramPath}/networkMode`,
            );
          }
          if (options.enforceHostAuthority !== false && options.hostPolicy?.allowPrivileged !== true) {
            throw new TaskpackError(
              'TASKPACK_HOST_BINDING_INVALID',
              'command.v1 parameters.networkMode: "loopback-only" requires operator host authorization (allowPrivileged)',
              `${paramPath}/networkMode`,
            );
          }
        }
        checkNetworkMode = nm;
      }

      const compiledParams: Record<string, TaskpackCheckParameterValue> = {
        script,
        ...(args !== undefined ? { args } : {}),
        ...(explicitTimeoutSeconds !== undefined ? { timeoutSeconds: explicitTimeoutSeconds } : {}),
        allowReadOnlyGitHubToken,
        env,
        ...(toolchainPaths !== undefined ? { toolchainPaths } : {}),
        ...(preserveRepoDirName !== undefined ? { preserveRepoDirName } : {}),
        ...(mountReadOnlyGit !== undefined ? { mountReadOnlyGit } : {}),
        ...(checkNetworkMode !== undefined ? { networkMode: checkNetworkMode } : {}),
      };
      return Object.freeze({
        id: checkId,
        implementation: 'command.v1' as const,
        parameters: Object.freeze(compiledParams),
      });
    }
    if (implementation === 'json-keys-guard.v1') {
      const paramPath = `/spec/verification/localChecks/${index}/parameters`;
      const params = requireObject(check['parameters'], paramPath, ['path', 'allowedPointers']);
      const targetPath = normalizeRelativePath(params['path'], `${paramPath}/path`);
      const rawPointers = requireStringList(params['allowedPointers'], `${paramPath}/allowedPointers`, 1, 128);
      const rfc6901PointerPattern = /^(?:\/(?:[^~/]|~[01])*)+$/;
      for (const [pIdx, pointer] of rawPointers.entries()) {
        if (pointer.length > 256 || !rfc6901PointerPattern.test(pointer)) {
          manifestInvalid(`json-keys-guard.v1 allowedPointer "${pointer}" must be a valid non-root RFC 6901 JSON Pointer of at most 256 characters`, `${paramPath}/allowedPointers/${pIdx}`);
        }
      }
      return Object.freeze({
        id: checkId,
        implementation: 'json-keys-guard.v1' as const,
        parameters: Object.freeze({
          path: targetPath,
          allowedPointers: Object.freeze([...rawPointers]),
        }),
      });
    }
    if (implementation === 'line-section-guard.v1') {
      const paramPath = `/spec/verification/localChecks/${index}/parameters`;
      const params = requireObject(check['parameters'], paramPath, ['path', 'startMarker', 'endMarker']);
      const targetPath = normalizeRelativePath(params['path'], `${paramPath}/path`);
      const startMarker = requireString(params['startMarker'], `${paramPath}/startMarker`, 1, 256);
      const endMarker = requireString(params['endMarker'], `${paramPath}/endMarker`, 1, 256);
      if (/[\r\n]/.test(startMarker)) {
        manifestInvalid('line-section-guard.v1 startMarker must not contain newline characters', `${paramPath}/startMarker`);
      }
      if (/[\r\n]/.test(endMarker)) {
        manifestInvalid('line-section-guard.v1 endMarker must not contain newline characters', `${paramPath}/endMarker`);
      }
      if (startMarker === endMarker) {
        manifestInvalid('line-section-guard.v1 startMarker and endMarker must be distinct', paramPath);
      }
      return Object.freeze({
        id: checkId,
        implementation: 'line-section-guard.v1' as const,
        parameters: Object.freeze({
          path: targetPath,
          startMarker,
          endMarker,
        }),
      });
    }
    const parametersKey = Object.hasOwn(check, 'parameters') ? 'parameters' : '';
    const record: {
      id: string;
      implementation: 'json-artifact.v1' | 'scope.v1' | 'no-change.v1';
      parameters?: Readonly<Record<string, string | number | boolean | null>>;
    } = {
      id: checkId,
      implementation: implementation as 'json-artifact.v1' | 'scope.v1' | 'no-change.v1',
    };
    if (parametersKey !== '') record.parameters = requireParameters(check['parameters'], `/spec/verification/localChecks/${index}/parameters`);
    return Object.freeze(record);
  });

  const commandScripts = localChecks
    .filter(c => c.implementation === 'command.v1')
    .map(c => String(c.parameters?.['script'] ?? ''))
    .filter(s => s.length > 0);

  const externalGates: TaskpackExternalGateDeclaration[] = externalGatesValue.map((item, index) => {
    const gPath = `/spec/verification/externalGates/${index}`;
    const gate = requireObject(item, gPath, [
      'id', 'gateId', 'endpointId', 'required', 'signingCredentialRef', 'authCredentialRef', 'url',
    ]);
    const gateCheckId = requireIdentifier(gate['id'], `${gPath}/id`);
    if (checkIds.has(gateCheckId)) manifestInvalid('duplicate check id across localChecks and externalGates', `${gPath}/id`);
    if (reservedIds.has(gateCheckId)) manifestInvalid(`check id "${gateCheckId}" is reserved by the compiler`, `${gPath}/id`);
    checkIds.add(gateCheckId);
    const endpointId = requireIdentifier(gate['endpointId'], `${gPath}/endpointId`);
    if (endpointId === LOCAL_COMMAND_GATE_ENDPOINT_ID) {
      manifestInvalid(
        `endpointId "${LOCAL_COMMAND_GATE_ENDPOINT_ID}" is reserved for command.v1 local checks`,
        `${gPath}/endpointId`,
      );
    }
    let signingCredentialRef: string | undefined;
    if (gate['signingCredentialRef'] !== undefined) {
      signingCredentialRef = requireString(gate['signingCredentialRef'], `${gPath}/signingCredentialRef`, 1, 64);
      if (!isValidCredentialRef(signingCredentialRef)) {
        manifestInvalid('invalid signingCredentialRef', `${gPath}/signingCredentialRef`);
      }
    }
    let authCredentialRef: string | undefined;
    if (gate['authCredentialRef'] !== undefined) {
      authCredentialRef = requireString(gate['authCredentialRef'], `${gPath}/authCredentialRef`, 1, 64);
      if (!isValidCredentialRef(authCredentialRef)) {
        manifestInvalid('invalid authCredentialRef', `${gPath}/authCredentialRef`);
      }
    }
    let url: string | undefined;
    if (gate['url'] !== undefined) {
      const urlStr = requireString(gate['url'], `${gPath}/url`, 1, 2048);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        manifestInvalid('external gate url is not a valid URL', `${gPath}/url`);
      }
      if (
        parsedUrl.href !== urlStr
        || parsedUrl.username !== ''
        || parsedUrl.password !== ''
        || parsedUrl.hash !== ''
        || parsedUrl.search !== ''
      ) {
        manifestInvalid('external gate url must be a normalized URL without credentials, query strings, or fragments', `${gPath}/url`);
      }
      const isLoopback = (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '[::1]') && parsedUrl.port !== '';
      if (parsedUrl.protocol !== 'https:' && !(options.allowLoopbackHttp === true && parsedUrl.protocol === 'http:' && isLoopback)) {
        manifestInvalid('external gate url must use https:// or explicit-port loopback http:// when allowLoopbackHttp is enabled', `${gPath}/url`);
      }
      url = urlStr;
    }
    return Object.freeze({
      id: gateCheckId,
      gateId: requireIdentifier(gate['gateId'], `${gPath}/gateId`),
      endpointId,
      required: requireBoolean(gate['required'], `${gPath}/required`),
      ...(signingCredentialRef === undefined ? {} : { signingCredentialRef }),
      ...(authCredentialRef === undefined ? {} : { authCredentialRef }),
      ...(url === undefined ? {} : { url }),
    });
  });

  // Optional `spec.publication` (defaults to `{ mode: 'disabled' }`; branch/title required only for `pull_request`).
  let publicationRecord: TaskpackPublicationDeclaration;
  if (spec['publication'] === undefined) {
    publicationRecord = Object.freeze({ mode: 'disabled' as const });
  } else {
    const publication = requireObject(spec['publication'], '/spec/publication', [
      'mode', 'targetBranch', 'headBranchPrefix', 'titleTemplate', 'bodyTemplate',
    ]);
    const publicationMode = requireString(publication['mode'], '/spec/publication/mode', 1, 16);
    if (publicationMode !== 'pull_request' && publicationMode !== 'disabled') {
      manifestInvalid('publication mode must be pull_request or disabled', '/spec/publication/mode');
    }
    const validateTargetBranch = (val: unknown): string => {
      const tb = requireString(val, '/spec/publication/targetBranch', 1, 128);
      if (!TARGET_BRANCH_PATTERN.test(tb)) manifestInvalid('targetBranch is not a valid branch name', '/spec/publication/targetBranch');
      return tb;
    };
    const validateHeadBranchPrefix = (val: unknown): string => {
      const hbp = requireString(val, '/spec/publication/headBranchPrefix', 1, 64);
      const trimmed = hbp.replace(/\/$/, '');
      const segments = trimmed.split('/');
      if (
        hbp.includes('//')
        || hbp.startsWith('/')
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/.test(trimmed)
        || segments.some(seg => seg.length === 0 || seg === '.' || seg === '..' || seg.startsWith('.') || seg.endsWith('.lock'))
      ) {
        manifestInvalid('headBranchPrefix is not a valid branch prefix', '/spec/publication/headBranchPrefix');
      }
      return hbp;
    };
    const bodyTemplate = publication['bodyTemplate'] === undefined
      ? undefined
      : requireMultilineString(publication['bodyTemplate'], '/spec/publication/bodyTemplate', 1, MAX_STRING);

    if (publicationMode === 'pull_request') {
      const targetBranch = validateTargetBranch(publication['targetBranch']);
      const headBranchPrefix = validateHeadBranchPrefix(publication['headBranchPrefix']);
      const titleTemplate = requireString(publication['titleTemplate'], '/spec/publication/titleTemplate', 1, 256);
      publicationRecord = Object.freeze({
        mode: 'pull_request' as const,
        targetBranch,
        headBranchPrefix,
        titleTemplate,
        ...(bodyTemplate === undefined ? {} : { bodyTemplate }),
      });
    } else {
      const targetBranch = publication['targetBranch'] === undefined
        ? undefined
        : validateTargetBranch(publication['targetBranch']);
      const headBranchPrefix = publication['headBranchPrefix'] === undefined
        ? undefined
        : validateHeadBranchPrefix(publication['headBranchPrefix']);
      const titleTemplate = publication['titleTemplate'] === undefined
        ? undefined
        : requireString(publication['titleTemplate'], '/spec/publication/titleTemplate', 1, 256);
      publicationRecord = Object.freeze({
        mode: 'disabled' as const,
        ...(targetBranch === undefined ? {} : { targetBranch }),
        ...(headBranchPrefix === undefined ? {} : { headBranchPrefix }),
        ...(titleTemplate === undefined ? {} : { titleTemplate }),
        ...(bodyTemplate === undefined ? {} : { bodyTemplate }),
      });
    }
  }

  // Optional `spec.memory` (defaults to `<controlRoot>/memory/default`, `apply: 'disabled'`, `onNoModelBudget: 'skip'`).
  const memoryRoot = `${controlRoot}/memory`;
  let memoryRecord: TaskpackMemoryDeclaration;
  if (spec['memory'] === undefined) {
    const defaultDirectory = `${memoryRoot}/default`;
    const memoryOverlap = writable.find(entry => scopePatternsMayIntersect(entry, `${defaultDirectory}/**`, false));
    if (memoryOverlap !== undefined) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `memory directory "${defaultDirectory}" overlaps writable path "${memoryOverlap}"`, '/spec/memory/directory');
    }
    memoryRecord = Object.freeze({
      directory: defaultDirectory,
      apply: 'disabled' as const,
      onNoModelBudget: 'skip' as const,
      ttlDays: DEFAULT_MEMORY_TTL_DAYS,
      maxEntries: DEFAULT_MEMORY_MAX_ENTRIES,
      maxPromptEntries: DEFAULT_MEMORY_MAX_PROMPT_ENTRIES,
      checkCodeFingerprint: false,
      checkUpstreamVersions: false,
      publishOnFailure: false,
      skipCi: true,
    });
  } else {
    const memory = requireObject(spec['memory'], '/spec/memory', [
      'directory', 'apply', 'onNoModelBudget', 'ttlDays', 'maxEntries', 'maxPromptEntries',
      'checkCodeFingerprint', 'checkUpstreamVersions', 'publishOnFailure', 'skipCi',
    ]);
    const memoryDirectory = normalizeRelativePath(memory['directory'], '/spec/memory/directory');
    if (!pathCoveredBy(memoryDirectory, memoryRoot)) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `memory directory must be under ${memoryRoot}`, '/spec/memory/directory');
    }
    const memoryOverlap = writable.find(entry => scopePatternsMayIntersect(entry, `${memoryDirectory}/**`, false));
    if (memoryOverlap !== undefined) {
      throw new TaskpackError('TASKPACK_SCOPE_VIOLATION', `memory directory "${memoryDirectory}" overlaps writable path "${memoryOverlap}"`, '/spec/memory/directory');
    }
    const applyRaw = requireString(memory['apply'], '/spec/memory/apply', 1, 32);
    if (applyRaw !== 'separate-pull-request' && applyRaw !== 'local-only' && applyRaw !== 'disabled') {
      manifestInvalid('memory apply must be separate-pull-request, local-only, or disabled', '/spec/memory/apply');
    }
    const apply: TaskpackMemoryApplyMode = applyRaw;
    let onNoModelBudget: TaskpackMemoryNoBudgetMode;
    if (memory['onNoModelBudget'] === undefined) {
      if (apply === 'disabled') {
        onNoModelBudget = 'skip';
      } else {
        manifestInvalid('onNoModelBudget must be deterministic-observations-only or skip', '/spec/memory/onNoModelBudget');
      }
    } else {
      const rawNoBudget = requireString(memory['onNoModelBudget'], '/spec/memory/onNoModelBudget', 1, 48);
      if (rawNoBudget !== 'deterministic-observations-only' && rawNoBudget !== 'skip') {
        manifestInvalid('onNoModelBudget must be deterministic-observations-only or skip', '/spec/memory/onNoModelBudget');
      }
      onNoModelBudget = rawNoBudget;
    }
    const ttlDays = memory['ttlDays'] === undefined
      ? DEFAULT_MEMORY_TTL_DAYS
      : requireSafeIntInRange(memory['ttlDays'], '/spec/memory/ttlDays', 1, 365);
    const maxEntries = memory['maxEntries'] === undefined
      ? DEFAULT_MEMORY_MAX_ENTRIES
      : requireSafeIntInRange(memory['maxEntries'], '/spec/memory/maxEntries', 1, 512);
    const maxPromptEntries = memory['maxPromptEntries'] === undefined
      ? DEFAULT_MEMORY_MAX_PROMPT_ENTRIES
      : requireSafeIntInRange(memory['maxPromptEntries'], '/spec/memory/maxPromptEntries', 1, 128);
    const checkCodeFingerprint = memory['checkCodeFingerprint'] === undefined
      ? false
      : requireBoolean(memory['checkCodeFingerprint'], '/spec/memory/checkCodeFingerprint');
    const checkUpstreamVersions = memory['checkUpstreamVersions'] === undefined
      ? false
      : requireBoolean(memory['checkUpstreamVersions'], '/spec/memory/checkUpstreamVersions');
    const publishOnFailure = memory['publishOnFailure'] === undefined
      ? false
      : requireBoolean(memory['publishOnFailure'], '/spec/memory/publishOnFailure');
    const skipCi = memory['skipCi'] === undefined
      ? true
      : requireBoolean(memory['skipCi'], '/spec/memory/skipCi');

    memoryRecord = Object.freeze({
      directory: memoryDirectory,
      apply,
      onNoModelBudget,
      ttlDays,
      maxEntries,
      maxPromptEntries,
      checkCodeFingerprint,
      checkUpstreamVersions,
      publishOnFailure,
      skipCi,
    });
  }

  // Optional `spec.triggers` (omitted normalizes to all-false and empty arrays).
  let triggersRecord: TaskpackTriggersDeclaration;
  if (spec['triggers'] === undefined) {
    triggersRecord = Object.freeze({
      schedule: false,
      workflowDispatch: false,
      releasePublished: false,
      commentCommands: Object.freeze([] as readonly TaskpackCommentCommand[]),
      commentPrefixes: Object.freeze([] as readonly string[]),
    });
  } else {
    const triggers = requireObject(spec['triggers'], '/spec/triggers', ['schedule', 'workflowDispatch', 'releasePublished', 'commentCommands', 'commentPrefixes']);
    const schedule = requireBoolean(triggers['schedule'], '/spec/triggers/schedule');
    const workflowDispatch = requireBoolean(triggers['workflowDispatch'], '/spec/triggers/workflowDispatch');
    const releasePublished = requireBoolean(triggers['releasePublished'], '/spec/triggers/releasePublished');
    const commentCommandsValue = triggers['commentCommands'];
    if (!Array.isArray(commentCommandsValue) || commentCommandsValue.length > TASKPACK_COMMENT_COMMANDS.length) {
      manifestInvalid(`commentCommands must contain 0..${TASKPACK_COMMENT_COMMANDS.length} entries`, '/spec/triggers/commentCommands');
    }
    const seenCommands = new Set<string>();
    const commentCommands = commentCommandsValue.map((item, index) => {
      const command = requireString(item, `/spec/triggers/commentCommands/${index}`, 1, 8);
      if (!(TASKPACK_COMMENT_COMMANDS as readonly string[]).includes(command)) manifestInvalid(`unsupported comment command "${command}"`, '/spec/triggers/commentCommands');
      if (seenCommands.has(command)) manifestInvalid('duplicate comment command', '/spec/triggers/commentCommands');
      seenCommands.add(command);
      return command as TaskpackCommentCommand;
    });
    const commentPrefixesValue = triggers['commentPrefixes'];
    const commentPrefixes = commentPrefixesValue === undefined
      ? DEFAULT_COMMENT_PREFIXES
      : requireStringList(commentPrefixesValue, '/spec/triggers/commentPrefixes', 1, 8).map((entry, index) => {
        if (!COMMENT_PREFIX_PATTERN.test(entry)) manifestInvalid(`comment prefix "${entry}" must match /<token>`, `/spec/triggers/commentPrefixes/${index}`);
        return entry;
      });
    triggersRecord = Object.freeze({
      schedule,
      workflowDispatch,
      releasePublished,
      commentCommands: Object.freeze(commentCommands),
      commentPrefixes: Object.freeze(commentPrefixes),
    });
  }

  if (policyProfile === 'github' && options.requireDeclaredTrigger === true && !hasAnyDeclaredGitHubTrigger(triggersRecord)) {
    throw new TaskpackError(
      'TASKPACK_TRIGGER_UNSUPPORTED',
      'manifest declares no enabled GitHub triggers under policyProfile "github"',
      '/spec/triggers',
    );
  }

  let sandbox: TaskpackSandboxDeclaration | undefined;
  if (spec['sandbox'] !== undefined) {
    const rawSandbox = requireObject(spec['sandbox'], '/spec/sandbox', ['preferredBackends', 'networkMode', 'requiredCapabilities', 'deniedReadPaths']);
    const allowedBackends: readonly SandboxBackendId[] = ['macos-seatbelt', 'linux-bwrap', 'linux-landlock', 'docker', 'direct-dedicated'];
    const allowedCapabilities: readonly SandboxCapability[] = [
      'filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask',
      'networkIsolation', 'processTreeCleanup', 'syscallFiltering',
    ];
    let preferredBackends: readonly SandboxBackendId[] | undefined;
    if (rawSandbox['preferredBackends'] !== undefined) {
      preferredBackends = Object.freeze(
        requireStringList(rawSandbox['preferredBackends'], '/spec/sandbox/preferredBackends', 1, 5).map((item, idx) => {
          if (!(allowedBackends as readonly string[]).includes(item)) {
            manifestInvalid(`unsupported sandbox backend "${item}"`, `/spec/sandbox/preferredBackends/${idx}`);
          }
          return item as SandboxBackendId;
        }),
      );
    }
    let networkMode: SandboxNetworkMode | undefined;
    if (rawSandbox['networkMode'] !== undefined) {
      const modeStr = requireString(rawSandbox['networkMode'], '/spec/sandbox/networkMode', 1, 32);
      if (modeStr !== 'none' && modeStr !== 'loopback-only' && modeStr !== 'allow-outbound') {
        manifestInvalid(`unsupported sandbox networkMode "${modeStr}"`, '/spec/sandbox/networkMode');
      }
      if (modeStr === 'allow-outbound' && !resolvedExecution.capabilities.allowAgentNetwork) {
        throw new TaskpackError(
          'TASKPACK_SCOPE_VIOLATION',
          'spec.sandbox.networkMode "allow-outbound" requires spec.execution.capabilities.allowAgentNetwork: true',
          '/spec/sandbox/networkMode',
        );
      }
      networkMode = modeStr;
    }
    let requiredCapabilities: readonly SandboxCapability[] | undefined;
    if (rawSandbox['requiredCapabilities'] !== undefined) {
      requiredCapabilities = Object.freeze(
        requireStringList(rawSandbox['requiredCapabilities'], '/spec/sandbox/requiredCapabilities', 0, 6).map((item, idx) => {
          if (!(allowedCapabilities as readonly string[]).includes(item)) {
            manifestInvalid(`unsupported sandbox capability "${item}"`, `/spec/sandbox/requiredCapabilities/${idx}`);
          }
          return item as SandboxCapability;
        }),
      );
    }
    let deniedReadPaths: readonly string[] | undefined;
    if (rawSandbox['deniedReadPaths'] !== undefined) {
      deniedReadPaths = Object.freeze(
        requireStringList(rawSandbox['deniedReadPaths'], '/spec/sandbox/deniedReadPaths', 0, 64).map((entry, idx) => {
          const itemPath = `/spec/sandbox/deniedReadPaths/${idx}`;
          if (entry.startsWith('~/')) {
            return `~/${normalizeRelativePath(entry.slice(2), itemPath)}`;
          }
          return normalizeRelativePath(entry, itemPath);
        }),
      );
    }
    const sandboxObj: {
      preferredBackends?: readonly SandboxBackendId[];
      networkMode?: SandboxNetworkMode;
      requiredCapabilities?: readonly SandboxCapability[];
      deniedReadPaths?: readonly string[];
    } = {};
    if (networkMode !== undefined) sandboxObj.networkMode = networkMode;
    if (preferredBackends !== undefined) sandboxObj.preferredBackends = preferredBackends;
    if (requiredCapabilities !== undefined) sandboxObj.requiredCapabilities = requiredCapabilities;
    if (deniedReadPaths !== undefined) sandboxObj.deniedReadPaths = deniedReadPaths;
    sandbox = Object.freeze(sandboxObj);
  }

  let decisions: TaskpackDecisionsDeclaration | undefined;
  if (spec['decisions'] !== undefined) {
    const rawDecisions = requireObject(spec['decisions'], '/spec/decisions', [
      'enabled', 'provider', 'disclosurePolicy', 'minConfidence', 'confirmThreshold',
      'hardDeadlineMs', 'maxAttempts', 'allowImages', 'triageRules',
    ]);
    const enabled = requireBoolean(rawDecisions['enabled'], '/spec/decisions/enabled');
    const allowedProviders: readonly TaskpackDecisionProviderKind[] = [
      'typesafe-jev', 'openai-decisions', 'startlux-decision', 'microsoft-decision',
      'perplexity-decider', 'cloudflare-clef', 'liquid-d1',
    ];
    const allowedDisclosures: readonly TaskpackDecisionDisclosurePolicy[] = [
      'disabled', 'repo-approved-redacted-evidence', 'public-metadata-only',
    ];
    const decisionsObj: {
      enabled: boolean;
      provider?: TaskpackDecisionProviderKind;
      disclosurePolicy?: TaskpackDecisionDisclosurePolicy;
      minConfidence?: number;
      confirmThreshold?: number;
      hardDeadlineMs?: number;
      maxAttempts?: 1 | 2;
      allowImages?: boolean;
      triageRules?: readonly TaskpackDecisionTriageRule[];
    } = { enabled };
    if (rawDecisions['provider'] !== undefined) {
      const providerStr = requireString(rawDecisions['provider'], '/spec/decisions/provider', 1, 64);
      if (!(allowedProviders as readonly string[]).includes(providerStr)) {
        manifestInvalid(`unsupported decisions provider "${providerStr}"`, '/spec/decisions/provider');
      }
      decisionsObj.provider = providerStr as TaskpackDecisionProviderKind;
    }
    if (rawDecisions['disclosurePolicy'] !== undefined) {
      const disclosureStr = requireString(rawDecisions['disclosurePolicy'], '/spec/decisions/disclosurePolicy', 1, 64);
      if (!(allowedDisclosures as readonly string[]).includes(disclosureStr)) {
        manifestInvalid(`unsupported decisions disclosurePolicy "${disclosureStr}"`, '/spec/decisions/disclosurePolicy');
      }
      decisionsObj.disclosurePolicy = disclosureStr as TaskpackDecisionDisclosurePolicy;
    }
    if (rawDecisions['minConfidence'] !== undefined) {
      const minConf = rawDecisions['minConfidence'];
      if (typeof minConf !== 'number' || !Number.isFinite(minConf) || minConf < 0.5 || minConf > 1) {
        manifestInvalid('decisions.minConfidence must be a finite number in [0.5, 1.0]', '/spec/decisions/minConfidence');
      }
      decisionsObj.minConfidence = minConf;
    }
    if (rawDecisions['confirmThreshold'] !== undefined) {
      const confirmThresh = rawDecisions['confirmThreshold'];
      if (typeof confirmThresh !== 'number' || !Number.isFinite(confirmThresh) || confirmThresh < 0 || confirmThresh > 1) {
        manifestInvalid('decisions.confirmThreshold must be a finite number in [0.0, 1.0]', '/spec/decisions/confirmThreshold');
      }
      decisionsObj.confirmThreshold = confirmThresh;
    }
    const effectiveConfirmThresh = decisionsObj.confirmThreshold ?? DEFAULT_DECISION_CONFIRM_THRESHOLD;
    const effectiveMinConf = decisionsObj.minConfidence ?? DEFAULT_DECISION_MIN_CONFIDENCE;
    if (effectiveConfirmThresh > effectiveMinConf) {
      manifestInvalid('decisions.confirmThreshold must not exceed minConfidence', '/spec/decisions/confirmThreshold');
    }
    if (rawDecisions['hardDeadlineMs'] !== undefined) {
      const deadline = rawDecisions['hardDeadlineMs'];
      if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline < 100 || deadline > 30_000) {
        manifestInvalid('decisions.hardDeadlineMs must be an integer in [100, 30000]', '/spec/decisions/hardDeadlineMs');
      }
      decisionsObj.hardDeadlineMs = deadline;
    }
    if (rawDecisions['maxAttempts'] !== undefined) {
      const attempts = rawDecisions['maxAttempts'];
      if (attempts !== 1 && attempts !== 2) {
        manifestInvalid('decisions.maxAttempts must be 1 or 2', '/spec/decisions/maxAttempts');
      }
      decisionsObj.maxAttempts = attempts;
    }
    if (rawDecisions['allowImages'] !== undefined) {
      decisionsObj.allowImages = requireBoolean(rawDecisions['allowImages'], '/spec/decisions/allowImages');
    }
    if (rawDecisions['triageRules'] !== undefined) {
      const rawRules = rawDecisions['triageRules'];
      if (!Array.isArray(rawRules) || rawRules.length > MAX_DECISION_TRIAGE_RULES) {
        manifestInvalid(`decisions.triageRules must be an array of 0..${MAX_DECISION_TRIAGE_RULES} entries`, '/spec/decisions/triageRules');
      }
      const seenRuleIds = new Set<string>();
      const rules: TaskpackDecisionTriageRule[] = rawRules.map((item, rIdx) => {
        const rulePath = `/spec/decisions/triageRules/${rIdx}`;
        const rawRule = requireObject(item, rulePath, ['id', 'description', 'severity', 'kind', 'threshold']);
        const ruleId = requireIdentifier(rawRule['id'], `${rulePath}/id`);
        if (seenRuleIds.has(ruleId)) manifestInvalid(`duplicate triage rule id "${ruleId}"`, `${rulePath}/id`);
        seenRuleIds.add(ruleId);
        const description = requireString(rawRule['description'], `${rulePath}/description`, 1, 512);
        const sevStr = requireString(rawRule['severity'], `${rulePath}/severity`, 1, 16);
        if (sevStr !== 'blocking' && sevStr !== 'important' && sevStr !== 'nit') {
          manifestInvalid('triage rule severity must be "blocking", "important", or "nit"', `${rulePath}/severity`);
        }
        const kindStr = requireString(rawRule['kind'], `${rulePath}/kind`, 1, 16);
        if (kindStr !== 'noul' && kindStr !== 'score') {
          manifestInvalid('triage rule kind must be "noul" or "score"', `${rulePath}/kind`);
        }
        let threshold: number | undefined;
        if (rawRule['threshold'] !== undefined) {
          const t = rawRule['threshold'];
          if (typeof t !== 'number' || !Number.isFinite(t) || Object.is(t, -0) || t < 0 || t > 1) {
            manifestInvalid('triage rule threshold must be a finite number in [0.0, 1.0]', `${rulePath}/threshold`);
          }
          threshold = t;
        }
        return Object.freeze({
          id: ruleId,
          description,
          severity: sevStr as TaskpackDecisionTriageSeverity,
          kind: kindStr as TaskpackDecisionTriageRuleKind,
          ...(threshold === undefined ? {} : { threshold }),
        });
      });
      decisionsObj.triageRules = Object.freeze(rules);
    }
    decisions = Object.freeze(decisionsObj);
  }

  const checkEnvConflict = (secretEnvs: ReadonlySet<string>, sourceLabel: string): void => {
    if (secretEnvs.size === 0) return;
    if (preflight?.env !== undefined) {
      for (const [eIdx, envName] of preflight.env.entries()) {
        if (secretEnvs.has(envName)) {
          manifestInvalid(`preflight env "${envName}" conflicts with ${sourceLabel}`, `/spec/preflight/env/${eIdx}`);
        }
      }
    }
    for (const [checkIdx, check] of localChecks.entries()) {
      if (check.implementation !== 'command.v1') continue;
      const envVal = check.parameters?.['env'];
      if (Array.isArray(envVal)) {
        for (const [envIdx, envName] of envVal.entries()) {
          if (typeof envName === 'string' && secretEnvs.has(envName)) {
            manifestInvalid(
              `command.v1 env "${envName}" conflicts with ${sourceLabel}`,
              `/spec/verification/localChecks/${checkIdx}/parameters/env/${envIdx}`,
            );
          }
        }
      } else if (envVal !== undefined && envVal !== null && typeof envVal === 'object') {
        for (const envName of Object.keys(envVal)) {
          if (secretEnvs.has(envName)) {
            manifestInvalid(
              `command.v1 env "${envName}" conflicts with ${sourceLabel}`,
              `/spec/verification/localChecks/${checkIdx}/parameters/env/${envName}`,
            );
          }
        }
      }
    }
  };

  let models: readonly TaskpackModelDeclaration[] | undefined;
  if (spec['models'] !== undefined) {
    models = validateTaskpackModelsDeclaration(spec['models'], '/spec/models');
    const modelApiKeyEnvs = new Set(
      models.map(m => m.apiKeyEnv).filter((v): v is string => v !== undefined),
    );
    checkEnvConflict(modelApiKeyEnvs, 'spec.models apiKeyEnv');
  }
  const externalGateSecretEnvs = new Set<string>();
  for (const gate of externalGates) {
    for (const ref of [gate.signingCredentialRef, gate.authCredentialRef]) {
      if (typeof ref === 'string' && COMMAND_ENV_NAME_PATTERN.test(ref)) {
        externalGateSecretEnvs.add(ref);
      }
    }
  }
  checkEnvConflict(externalGateSecretEnvs, 'spec.verification.externalGates credential ref');
  checkEnvConflict(new Set(Object.values(DECISION_PROVIDER_API_KEY_ENV).flat()), 'spec.decisions provider api key');

  let mcp: TaskpackMcpDeclaration | undefined;
  if (spec['mcp'] !== undefined) {
    const rawMcp = Array.isArray(spec['mcp'])
      ? { servers: spec['mcp'] }
      : requireObject(spec['mcp'], '/spec/mcp', ['servers']);
    const servers = validateMcpServerDeclarations(
      rawMcp['servers'],
      Array.isArray(spec['mcp']) ? '/spec/mcp' : '/spec/mcp/servers',
      { allowLoopbackHttp: options.allowLoopbackHttp },
    );
    mcp = Object.freeze({ servers });
    checkEnvConflict(collectMcpReferencedEnvNames(servers), 'spec.mcp secret env binding');
  }

  const mcpServerById = new Map<string, TaskpackMcpServerDeclaration>(mcp?.servers.map(s => [s.id, s]) ?? []);
  let roles: readonly TaskpackRoleDeclaration[] | undefined;
  const roleById = new Map<string, TaskpackRoleDeclaration>();
  const allRoleInstructions: string[] = [];
  const allRoleSkills: string[] = [];
  if (spec['roles'] !== undefined) {
    const rawRoles = spec['roles'];
    if (!Array.isArray(rawRoles) || rawRoles.length < 1 || rawRoles.length > MAX_TASKPACK_ROLES) {
      manifestInvalid(`spec.roles must contain 1..${MAX_TASKPACK_ROLES} entries`, '/spec/roles');
    }
    const roleIds = new Set<string>();
    const reservedRoleIds = new Set([
      ...reservedIds,
      'controller.scope',
      'controller.no-change',
      'author-candidate',
      'author-assessment',
    ]);
    const roleIndexById = new Map<string, number>();
    const parsedRoles: TaskpackRoleDeclaration[] = rawRoles.map((item, idx) => {
      const rPath = `/spec/roles/${idx}`;
      const rawRole = requireObject(item, rPath, [
        'id', 'purpose', 'provider', 'model', 'thinking', 'tools', 'dependsOn',
        'instructions', 'skills', 'prompt', 'mcpServers', 'models',
      ]);
      const roleId = requireIdentifier(rawRole['id'], `${rPath}/id`);
      if (roleIds.has(roleId)) manifestInvalid(`duplicate role id "${roleId}"`, `${rPath}/id`);
      if (checkIds.has(roleId)) manifestInvalid(`role id "${roleId}" collides with check id`, `${rPath}/id`);
      if (reservedRoleIds.has(roleId)) manifestInvalid(`role id "${roleId}" is reserved`, `${rPath}/id`);
      roleIds.add(roleId);

      let purpose: TaskpackRolePurpose = 'task';
      if (rawRole['purpose'] !== undefined) {
        const pStr = requireString(rawRole['purpose'], `${rPath}/purpose`, 1, 16);
        if (pStr !== 'task' && pStr !== 'review') {
          manifestInvalid('role purpose must be "task" or "review"', `${rPath}/purpose`);
        }
        purpose = pStr;
      }

      const provider = requireLabel(rawRole['provider'], `${rPath}/provider`);
      const model = requireLabel(rawRole['model'], `${rPath}/model`);
      const thinking = rawRole['thinking'] === undefined
        ? 'medium'
        : requireLabel(rawRole['thinking'], `${rPath}/thinking`);

      let tools: readonly TaskpackToolName[];
      if (rawRole['tools'] === undefined) {
        tools = purpose === 'review'
          ? Object.freeze(['read'] as const)
          : Object.freeze(['read', 'write', 'edit', 'bash'] as const);
      } else {
        const rawTools = requireStringList(rawRole['tools'], `${rPath}/tools`, 1, TASKPACK_TOOL_NAMES.length);
        const validatedTools: TaskpackToolName[] = [];
        for (const [tIdx, toolStr] of rawTools.entries()) {
          if (!(TASKPACK_TOOL_NAMES as readonly string[]).includes(toolStr)) {
            manifestInvalid(`unsupported role tool "${toolStr}"`, `${rPath}/tools/${tIdx}`);
          }
          if (purpose === 'review' && (toolStr === 'write' || toolStr === 'edit' || toolStr === 'delete')) {
            manifestInvalid(
              `review role "${roleId}" must not declare mutating tool "${toolStr}"`,
              `${rPath}/tools/${tIdx}`,
            );
          }
          validatedTools.push(toolStr as TaskpackToolName);
        }
        tools = Object.freeze(validatedTools);
      }

      let dependsOn: readonly string[] = Object.freeze([]);
      if (rawRole['dependsOn'] !== undefined) {
        const rawDeps = requireStringList(rawRole['dependsOn'], `${rPath}/dependsOn`, 0, MAX_TASKPACK_ROLES - 1);
        for (const [dIdx, depId] of rawDeps.entries()) {
          requireIdentifier(depId, `${rPath}/dependsOn/${dIdx}`);
          const parentIdx = roleIndexById.get(depId);
          if (parentIdx === undefined || parentIdx >= idx) {
            manifestInvalid(
              `role "${roleId}" dependsOn "${depId}" must reference a prior role id`,
              `${rPath}/dependsOn/${dIdx}`,
            );
          }
        }
        dependsOn = Object.freeze([...rawDeps]);
      }

      const roleInstructions = rawRole['instructions'] === undefined
        ? undefined
        : validateRelativePathOrList(rawRole['instructions'], `${rPath}/instructions`);
      if (roleInstructions !== undefined) allRoleInstructions.push(...roleInstructions);

      const roleSkills = rawRole['skills'] === undefined
        ? undefined
        : validateRelativePathOrList(rawRole['skills'], `${rPath}/skills`);
      if (roleSkills !== undefined) allRoleSkills.push(...roleSkills);

      const prompt = rawRole['prompt'] === undefined
        ? undefined
        : requireMultilineString(rawRole['prompt'], `${rPath}/prompt`, 1, MAX_STRING);

      let mcpServers: readonly string[] | undefined;
      if (rawRole['mcpServers'] !== undefined) {
        const rawServers = requireStringList(rawRole['mcpServers'], `${rPath}/mcpServers`, 0, 16);
        for (const [mIdx, serverId] of rawServers.entries()) {
          const declaredServer = MCP_SERVER_ID_PATTERN.test(serverId) ? mcpServerById.get(serverId) : undefined;
          if (declaredServer === undefined) {
            manifestInvalid(
              `role "${roleId}" mcpServers references undeclared MCP server "${serverId}"`,
              `${rPath}/mcpServers/${mIdx}`,
            );
          }
          if (purpose === 'review' && declaredServer.readOnly !== true) {
            manifestInvalid(
              `review role "${roleId}" mcpServers entry "${serverId}" must reference a readOnly MCP server`,
              `${rPath}/mcpServers/${mIdx}`,
            );
          }
        }
        mcpServers = Object.freeze([...rawServers]);
      } else if (purpose === 'review') {
        mcpServers = Object.freeze([]);
      }

      let roleModels: readonly string[] | undefined;
      if (rawRole['models'] !== undefined) {
        const rawRoleModels = requireStringList(rawRole['models'], `${rPath}/models`, 1, 8);
        roleModels = Object.freeze(rawRoleModels.map((m, mIdx) => requireLabel(m, `${rPath}/models/${mIdx}`)));
      }

      roleIndexById.set(roleId, idx);
      const roleDecl: TaskpackRoleDeclaration = Object.freeze({
        id: roleId,
        purpose,
        provider,
        model,
        thinking,
        tools,
        dependsOn,
        ...(roleInstructions === undefined ? {} : { instructions: roleInstructions }),
        ...(roleSkills === undefined ? {} : { skills: roleSkills }),
        ...(prompt === undefined ? {} : { prompt }),
        ...(mcpServers === undefined ? {} : { mcpServers }),
        ...(roleModels === undefined ? {} : { models: roleModels }),
      });
      roleById.set(roleId, roleDecl);
      return roleDecl;
    });

    roles = Object.freeze(parsedRoles);
  }

  let steps: readonly TaskpackStepDeclaration[] | undefined;
  if (spec['steps'] !== undefined) {
    steps = validateStepsDag(spec['steps'], roleById, checkIds, options.executionMode);
  }

  // Final effective protected-path check including command scripts, preflight script, lockfile, toolchainPaths, and per-role assets.
  const combinedInstructions = [...(instructions ?? []), ...allRoleInstructions];
  const combinedSkills = [...(skills ?? []), ...allRoleSkills];
  const extraProtectedPaths = options.extraProtectedPaths?.map((entry, idx) => (
    normalizeScopePattern(entry, `/extraProtectedPaths/${idx}`)
  ));
  const finalProtected = resolveProtectedPathSets(manifestProtected, {
    policyProfile,
    controlRoot,
    manifestPath,
    digestsLockfile,
    instructions: combinedInstructions.length > 0 ? combinedInstructions : undefined,
    skills: combinedSkills.length > 0 ? combinedSkills : undefined,
    preflightScript: preflight?.script,
    commandScripts,
    toolchainPaths: relativeToolchainPaths.length > 0 ? relativeToolchainPaths : undefined,
    proposalPath,
    extraProtectedPaths,
    allowWorkflowWrites,
    githubSiblings: options.githubSiblings,
  });
  const allProtected = finalProtected.allProtected;
  if (allProtected.length > 128) {
    manifestInvalid('effective protected path set exceeds 128 entries', '/spec/scope/protected');
  }
  assertWritablesDisjointFromProtected(
    writable,
    allProtected,
    finalProtected.mandatoryProtectedSet,
    controlRoot,
    proposalPath,
    policyProfile,
    allowWorkflowWrites,
  );
  if (proposalPath !== undefined) {
    pathInsideWritable(proposalPath, writable, allProtected, '/spec/proposal/path', legacyPrefixFallback, policyProfile, allowWorkflowWrites, manifestProtectedSet);
    if (
      (pathCoveredBy(proposalPath, controlRoot) || pathCoveredByCaseInsensitive(proposalPath, controlRoot))
      && !isControlRootProposalWritableAllowed(
        proposalPath,
        writable,
        controlRoot,
        finalProtected.explicitWithManifest,
      )
    ) {
      throw new TaskpackError(
        'TASKPACK_SCOPE_VIOLATION',
        `spec.proposal.path "${proposalPath}" inside control root "${controlRoot}" must be listed as an exact file in spec.scope.writable without overlapping protected control-plane paths`,
        '/spec/proposal/path',
      );
    }
  }
  if (submissionDecl !== undefined) {
    pathInsideWritable(submissionDecl.path, writable, allProtected, '/spec/submission/path', legacyPrefixFallback, policyProfile, allowWorkflowWrites, manifestProtectedSet);
  }

  let output: TaskpackOutputDeclaration | undefined;
  if (spec['output'] !== undefined) {
    const parseOutputFormats = (rawFormats: unknown, fmtPath: string): readonly TaskpackOutputFormat[] => {
      const asOutputFormat = (token: string, tokenPath: string): TaskpackOutputFormat => {
        const matched = TASKPACK_OUTPUT_FORMATS.find(fmt => fmt === token);
        if (matched === undefined) {
          manifestInvalid(`unsupported output format "${token}"`, tokenPath);
        }
        return matched;
      };
      if (typeof rawFormats === 'string') {
        if (rawFormats.length === 0 || /[\0\r\n]/.test(rawFormats)) {
          manifestInvalid('output formats string must be non-empty without control characters', fmtPath);
        }
        const parts = rawFormats.split(',').map(part => part.trim());
        if (parts.length > TASKPACK_OUTPUT_FORMATS.length) {
          manifestInvalid(`expected 1..${TASKPACK_OUTPUT_FORMATS.length} output formats`, fmtPath);
        }
        const seen = new Set<TaskpackOutputFormat>();
        const parsed: TaskpackOutputFormat[] = [];
        for (const part of parts) {
          if (part.length === 0) {
            manifestInvalid('output formats must not contain empty tokens', fmtPath);
          }
          const fmt = asOutputFormat(part, fmtPath);
          if (seen.has(fmt)) {
            manifestInvalid(`duplicate output format "${fmt}"`, fmtPath);
          }
          seen.add(fmt);
          parsed.push(fmt);
        }
        return Object.freeze(parsed);
      }
      const list = requireStringList(rawFormats, fmtPath, 1, TASKPACK_OUTPUT_FORMATS.length);
      const seen = new Set<string>();
      const formats: TaskpackOutputFormat[] = [];
      for (const [idx, fmt] of list.entries()) {
        const normalized = asOutputFormat(fmt, `${fmtPath}/${idx}`);
        if (seen.has(normalized)) {
          manifestInvalid(`duplicate output format "${normalized}"`, `${fmtPath}/${idx}`);
        }
        seen.add(normalized);
        formats.push(normalized);
      }
      return Object.freeze(formats);
    };

    const rawSpecOutput = spec['output'];
    const formats = typeof rawSpecOutput === 'string' || Array.isArray(rawSpecOutput)
      ? parseOutputFormats(rawSpecOutput, '/spec/output')
      : parseOutputFormats(requireObject(rawSpecOutput, '/spec/output', ['formats'])['formats'], '/spec/output/formats');
    output = Object.freeze({ formats });
  }

  const baseSpec: TaskpackV2Manifest['spec'] = Object.freeze({
    goal: Object.freeze({ candidate: goalCandidate, noChange: goalNoChange }),
    scope: Object.freeze({ writable: Object.freeze(writable), protected: Object.freeze(manifestProtected) }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(skills === undefined ? {} : { skills }),
    ...(schemaMode === 'v2' || hasExplicitExecution ? { execution: resolvedExecution } : {}),
    ...(preflight === undefined ? {} : { preflight }),
    ...(vars === undefined ? {} : { vars }),
    ...(target === undefined ? {} : { target }),
    upstreams: Object.freeze(upstreams),
    ...(upstreamGroups === undefined ? {} : { upstreamGroups }),
    ...(proposalDecl === undefined ? {} : { proposal: proposalDecl }),
    ...(submissionDecl === undefined ? {} : { submission: submissionDecl }),
    verification: Object.freeze({ localChecks: Object.freeze(localChecks), externalGates: Object.freeze(externalGates) }),
    publication: publicationRecord,
    memory: memoryRecord,
    triggers: triggersRecord,
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(models === undefined ? {} : { models }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(limits === undefined ? {} : { limits }),
    ...(roles === undefined ? {} : { roles }),
    ...(steps === undefined ? {} : { steps }),
    ...(output === undefined ? {} : { output }),
  });

  const manifest: TaskpackV2Manifest = {
    apiVersion: TASKPACK_MANIFEST_API_VERSION,
    kind: 'Taskpack',
    metadata: Object.freeze({ name }),
    spec: baseSpec,
  };
  // Keep controlRoot and manifestPath non-enumerable so JSON.stringify round-trips cleanly.
  Object.defineProperty(manifest, 'controlRoot', { value: controlRoot, enumerable: false });
  if (manifestPath !== undefined) {
    Object.defineProperty(manifest, 'manifestPath', { value: manifestPath, enumerable: false });
  }
  return Object.freeze(manifest);
}

/**
 * Validate a parsed Taskpack 2.0 manifest document (defaulting `policyProfile` to `'local'`).
 */
export function validateTaskpackV2Manifest(value: Json, options: ValidateTaskpackManifestOptions = {}): TaskpackV2Manifest {
  return validateTaskpackManifestInternal(value, options, 'v2');
}

/** Alias for `validateTaskpackV2Manifest` validating a parsed Taskpack manifest object. */
export function validateTaskpackManifestObject(raw: Json, options: ValidateTaskpackManifestOptions = {}): TaskpackV2Manifest {
  return validateTaskpackManifestInternal(raw, options, 'v2');
}

/** Parse YAML text/bytes and validate as a Taskpack 2.0 manifest (defaulting `policyProfile` to `'local'`). */
export function parseTaskpackManifest(
  rawYaml: string | Uint8Array,
  options: ValidateTaskpackManifestOptions = {},
): TaskpackV2Manifest {
  const bytes = typeof rawYaml === 'string' ? Buffer.from(rawYaml, 'utf8') : rawYaml;
  const parsed = parseTaskpackDocument(bytes, 'yaml');
  return validateTaskpackV2Manifest(parsed, options);
}

/**
 * Validate a parsed manifest document and return the compile-compatible `TaskpackManifestWithProposal`
 * (requiring `spec.proposal` and v1 check implementations for legacy callers while supporting all additive
 * Taskpack 2.0 fields).
 */
export function validateTaskpackManifest(value: Json, options: ValidateTaskpackManifestOptions = {}): TaskpackManifestWithProposal {
  const v2 = validateTaskpackManifestInternal(value, options, 'v1-compat');
  if (v2.spec.proposal === undefined) {
    manifestInvalid('spec.proposal is required', '/spec/proposal');
  }
  return v2 as unknown as TaskpackManifestWithProposal;
}
