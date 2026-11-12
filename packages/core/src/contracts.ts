import { API_VERSION, snapshot, type Json } from './boundary.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { LIMITS } from './limits.js';
import { graphBounds, unique, validateGraph } from './graph.js';
import { matches, relativeName, scopePattern } from './scope.js';

export type Schema<T> = (value: Json, path: string) => T;
export type Infer<S> = S extends Schema<infer T> ? T : never;
type Shape = Readonly<Record<string, Schema<unknown>>>;

export function object(value: Json, path: string): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('VALUE_TYPE', path);
  return value;
}
export function record<const S extends Shape>(shape: S): Schema<{ readonly [K in keyof S]: Infer<S[K]> }> {
  return (value, path) => {
    const input = object(value, path), keys = Object.keys(shape);
    for (const key of keys) if (!Object.hasOwn(input, key)) fail('FIELD_REQUIRED', `${path}/${key}`);
    for (const key of Object.keys(input).sort()) if (!Object.hasOwn(shape, key)) fail('FIELD_UNKNOWN', path);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) output[key] = shape[key]!(input[key]!, `${path}/${key}`);
    return output as { readonly [K in keyof S]: Infer<S[K]> };
  };
}
export function text(min = 1, max: number = LIMITS.string): Schema<string> {
  return (value, path) => {
    if (typeof value !== 'string') fail('VALUE_TYPE', path);
    if (value.length < min || value.length > max) fail('VALUE_RANGE', path);
    return value;
  };
}
export function enumeration<const V extends readonly string[]>(...values: V): Schema<V[number]> {
  return (value, path) => {
    if (typeof value !== 'string') fail('VALUE_TYPE', path);
    if (!values.includes(value)) fail('VALUE_ENUM', path);
    return value as V[number];
  };
}
export const boolean: Schema<boolean> = (value, path) => {
  if (typeof value !== 'boolean') fail('VALUE_TYPE', path);
  return value;
};
export function integer(min = 0): Schema<number> {
  return (value, path) => {
    if (typeof value !== 'number') fail('VALUE_TYPE', path);
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min) fail('VALUE_RANGE', path);
    return value;
  };
}
export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return (value, path) => value === null ? null : schema(value, path);
}
export function arrayOf<T>(schema: Schema<T>, min = 0, max: number = LIMITS.collection): Schema<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) fail('VALUE_TYPE', path);
    if (value.length < min || value.length > max) fail('VALUE_RANGE', path);
    return value.map((item, index) => schema(item, `${path}/${index}`));
  };
}
export const identifier: Schema<string> = (value, path) => {
  const name = text(1, LIMITS.identifier)(value, path);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name)) fail('IDENTIFIER_INVALID', path);
  return name;
};
export const toolName: Schema<string> = (value, path) => {
  const name = text(1, LIMITS.toolName)(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:[.:-][A-Za-z0-9_]+)*$/.test(name)) fail('IDENTIFIER_INVALID', path);
  return name;
};
export const label: Schema<string> = (value, path) => {
  const name = text(1, 128)(value, path);
  if (/[\s\p{C}]/u.test(name)) fail('IDENTIFIER_INVALID', path);
  return name;
};
export const revision: Schema<string> = (value, path) => {
  const name = text(1, 128)(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(name)) fail('IDENTIFIER_INVALID', path);
  return name;
};
export const repository: Schema<string> = (value, path) => {
  const name = text(1, 256)(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) fail('IDENTIFIER_INVALID', path);
  return name;
};
export const nameSchema: Schema<string> = (value, path) => relativeName(text(1, LIMITS.path)(value, path), path);
const pattern: Schema<string> = (value, path) => scopePattern(text(1, LIMITS.path)(value, path), path);
export const digestSchema = record({ algorithm: enumeration('sha256'), hex: (value: Json, path: string) => {
  const hex = text(64, 64)(value, path);
  if (!/^[0-9a-f]{64}$/.test(hex)) fail('VALUE_RANGE', path);
  return hex;
} });
export type Digest = Infer<typeof digestSchema>;
export const artifactRefSchema = record({ name: nameSchema, digest: digestSchema, byteLength: integer() });
export type ArtifactRef = Infer<typeof artifactRefSchema>;
export function document<const K extends string, T>(kind: K, spec: Schema<T>) {
  const shape = record({ apiVersion: enumeration(API_VERSION), kind: enumeration(kind), metadata: record({ id: identifier }), spec });
  return (value: Json, path: string): Infer<typeof shape> => {
    const input = object(value, path);
    if (!Object.hasOwn(input, 'apiVersion')) fail('FIELD_REQUIRED', `${path}/apiVersion`);
    if (input.apiVersion !== API_VERSION) fail('VERSION_UNSUPPORTED', `${path}/apiVersion`);
    if (input.kind !== kind) fail('KIND_MISMATCH', `${path}/kind`);
    return shape(value, path);
  };
}
export function configDocument<const K extends string, T>(kind: K, spec: Schema<T>) {
  const shape = record({ apiVersion: enumeration(API_VERSION), kind: enumeration(kind), spec });
  return (value: Json, path: string): Infer<typeof shape> => {
    const input = object(value, path);
    if (!Object.hasOwn(input, 'apiVersion')) fail('FIELD_REQUIRED', `${path}/apiVersion`);
    if (input.apiVersion !== API_VERSION) fail('VERSION_UNSUPPORTED', `${path}/apiVersion`);
    if (input.kind !== kind) fail('KIND_MISMATCH', `${path}/kind`);
    return shape(value, path);
  };
}
export const evidenceLevel = enumeration('static_inspection', 'synthetic_fixture', 'local_execution', 'external_service', 'hardware_execution');
export type EvidenceLevel = Infer<typeof evidenceLevel>;
export const checkStatus = enumeration('passed', 'failed', 'blocked', 'not_run');
export type CheckStatus = Infer<typeof checkStatus>;
const mode = enumeration('hard_admission', 'soft_accounting');
const budgets = record({
  wallTimeMs: integer(1), totalTokens: integer(1), perCallOutputTokens: integer(1),
  maxModelCalls: integer(1), maxConcurrency: integer(1), maxFormatRepairs: integer(),
  maxImplementationRepairs: integer(), maxTransportRetries: integer(),
  enforcement: record({ wallTime: mode, tokens: mode, modelCalls: mode, concurrency: mode,
    formatRepairs: mode, implementationRepairs: mode, transportRetries: mode }),
});
const taskShape = configDocument('TaskContract', record({
  goal: text(1, LIMITS.goal), taskpack: identifier,
  target: record({ repository, baseRevision: revision, sourceRevision: revision,
    matrix: nullable(arrayOf(record({ id: identifier, platform: label, variant: label }), 1, LIMITS.targets)) }),
  scope: record({ writable: arrayOf(pattern, 1, LIMITS.patterns), protected: arrayOf(pattern, 0, LIMITS.patterns) }),
  roles: arrayOf(record({ id: identifier, adapter: label, provider: label, model: label, thinking: label,
    tools: arrayOf(toolName, 0, LIMITS.tools) }), 1, LIMITS.roles),
  trustedContext: record({ revision, discovery: enumeration('disabled'), resources: arrayOf(record({
    id: identifier, kind: enumeration('instruction', 'skill', 'document'), path: nameSchema, digest: digestSchema,
  }), 0, LIMITS.resources) }),
  budgets,
  steps: arrayOf(record({ id: identifier, kind: enumeration('agent', 'check'), uses: identifier,
    roleId: nullable(identifier), dependsOn: arrayOf(identifier) }), 1),
  acceptance: record({ required: arrayOf(identifier, 1, LIMITS.checks), checks: arrayOf(record({
    id: identifier, allowedEvidenceLevels: arrayOf(evidenceLevel, 1, 5),
  }), 1, LIMITS.checks) }),
}));
export type TaskContract = Infer<typeof taskShape>;
export function contractSchema(input: Json, path = ''): TaskContract {
  const value = taskShape(input, path), spec = value.spec;
  const rolesPath = `${path}/spec/roles`, stepsPath = `${path}/spec/steps`;
  unique(spec.roles.map(role => role.id), rolesPath);
  spec.roles.forEach((role, index) => unique(role.tools, `${rolesPath}/${index}/tools`));
  unique(spec.trustedContext.resources.map(item => item.id), `${path}/spec/trustedContext/resources`);
  unique(spec.trustedContext.resources.map(item => item.path), `${path}/spec/trustedContext/resources`);
  if (spec.target.matrix) unique(spec.target.matrix.map(cell => cell.id), `${path}/spec/target/matrix`);
  unique(spec.scope.writable, `${path}/spec/scope/writable`);
  unique(spec.scope.protected, `${path}/spec/scope/protected`);
  unique(spec.acceptance.required, `${path}/spec/acceptance/required`);
  unique(spec.acceptance.checks.map(check => check.id), `${path}/spec/acceptance/checks`);
  spec.acceptance.checks.forEach((check, index) => unique(check.allowedEvidenceLevels, `${path}/spec/acceptance/checks/${index}/allowedEvidenceLevels`));
  graphBounds(spec.steps, stepsPath);
  const checkIds = new Set(spec.acceptance.checks.map(check => check.id));
  spec.acceptance.required.forEach((id, index) => { if (!checkIds.has(id)) fail('REFERENCE_UNKNOWN', `${path}/spec/acceptance/required/${index}`); });
  const roleIds = new Set(spec.roles.map(role => role.id));
  spec.steps.forEach((step, index) => {
    if (step.roleId === null ? step.kind === 'agent' : !roleIds.has(step.roleId)) fail('REFERENCE_UNKNOWN', `${stepsPath}/${index}/roleId`);
  });
  validateGraph(spec.steps, stepsPath);
  const budget = spec.budgets;
  if (budget.perCallOutputTokens > budget.totalTokens || budget.maxConcurrency > budget.maxModelCalls
    || budget.maxFormatRepairs > budget.maxModelCalls || budget.maxImplementationRepairs > budget.maxModelCalls
    || budget.maxTransportRetries > budget.maxModelCalls) fail('BUDGET_INCONSISTENT', `${path}/spec/budgets`);
  return value;
}
export function isWritablePath(input: unknown, path: unknown): Result<boolean> {
  return attempt(() => {
    const contract = contractSchema(snapshot(input));
    // Wrap scalar input so strings are treated as data, not JSON documents.
    const name = nameSchema(object(snapshot({ path }), '').path!, '/path');
    return !contract.spec.scope.protected.some(pattern => matches(pattern, name))
      && contract.spec.scope.writable.some(pattern => matches(pattern, name));
  });
}
