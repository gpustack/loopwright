import { API_VERSION, snapshot, type Json } from './boundary.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { LIMITS, OVERLAY_LIMITS, type OverlayLimits } from './limits.js';
import { graphBounds, unique, validateGraph } from './graph.js';
import { matches, relativeName, scopePattern } from './scope.js';

export type Schema<T> = (value: Json, path: string) => T;
export type Infer<S> = S extends Schema<infer T> ? T : never;

const OPTIONAL_SCHEMA = Symbol('optional-schema');
export interface OptionalSchema<T> {
  readonly [OPTIONAL_SCHEMA]: true;
  readonly schema: Schema<T>;
}
export function optional<T>(schema: Schema<T>): OptionalSchema<T> {
  return { [OPTIONAL_SCHEMA]: true, schema };
}
type FieldSchema = Schema<unknown> | OptionalSchema<unknown>;
type Shape = Readonly<Record<string, FieldSchema>>;
type RequiredKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? never : K;
}[keyof S];
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];
type InferField<F> = F extends OptionalSchema<infer T> ? T : F extends Schema<infer T> ? T : never;
type Prettify<T> = { [K in keyof T]: T[K] } & {};
type RecordOutput<S extends Shape> = Prettify<
  { readonly [K in RequiredKeys<S>]: InferField<S[K]> }
  & { readonly [K in OptionalKeys<S>]?: InferField<S[K]> }
>;
function isOptionalSchema(field: FieldSchema): field is OptionalSchema<unknown> {
  return typeof field === 'object' && field !== null && OPTIONAL_SCHEMA in field;
}

export function object(value: Json, path: string): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('VALUE_TYPE', path);
  return value;
}
export function branch<A, B>(
  predicate: (input: Record<string, Json>) => boolean,
  whenTrue: Schema<A>,
  whenFalse: Schema<B>,
): Schema<A | B> {
  return (value, path) => {
    const input = object(value, path);
    return predicate(input) ? whenTrue(input, path) : whenFalse(input, path);
  };
}
export function record<const S extends Shape>(shape: S): Schema<RecordOutput<S>> {
  return (value, path) => {
    const input = object(value, path), keys = Object.keys(shape);
    for (const key of keys) {
      if (!isOptionalSchema(shape[key]!) && !Object.hasOwn(input, key)) fail('FIELD_REQUIRED', `${path}/${key}`);
    }
    for (const key of Object.keys(input).sort()) if (!Object.hasOwn(shape, key)) fail('FIELD_UNKNOWN', path);
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const field = shape[key]!;
      if (isOptionalSchema(field)) {
        if (Object.hasOwn(input, key)) output[key] = field.schema(input[key]!, `${path}/${key}`);
      } else {
        output[key] = field(input[key]!, `${path}/${key}`);
      }
    }
    return output as RecordOutput<S>;
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
export function integer(min = 0, max = Number.MAX_SAFE_INTEGER): Schema<number> {
  return (value, path) => {
    if (typeof value !== 'number') fail('VALUE_TYPE', path);
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail('VALUE_RANGE', path);
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

export const artifactUri: Schema<string> = (value, path) => {
  const uri = text(1, LIMITS.artifactUri)(value, path);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\p{C}]+$/u.test(uri)) fail('VALUE_RANGE', path);
  return uri;
};
export const mediaType: Schema<string> = (value, path) => {
  const mime = text(1, LIMITS.mediaType)(value, path);
  if (/[\r\n\p{C}]/u.test(mime)) fail('VALUE_RANGE', path);
  const parts = mime.split(';');
  const essence = parts[0]!.trim();
  if (essence !== parts[0]! || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(essence)) {
    fail('VALUE_RANGE', path);
  }
  for (let index = 1; index < parts.length; index++) {
    const param = parts[index]!.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*=[A-Za-z0-9!#$&^_.+-]+$/.test(param)) fail('VALUE_RANGE', path);
  }
  return mime;
};

const FORBIDDEN_PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type MetricValue = number | string | boolean;
export type MetricsMap = Readonly<Record<string, MetricValue>>;
export function metricsSchema(value: Json, path: string): MetricsMap {
  const input = object(value, path);
  const keys = Object.keys(input).sort();
  if (keys.length > LIMITS.metricEntries) fail('VALUE_RANGE', path);
  const output: Record<string, MetricValue> = Object.create(null) as Record<string, MetricValue>;
  for (const key of keys) {
    if (
      key.length < 1 || key.length > LIMITS.metricKey
      || FORBIDDEN_PROTOTYPE_KEYS.has(key)
      || !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(key)
    ) {
      fail('IDENTIFIER_INVALID', path);
    }
    const entryPath = `${path}/${key}`;
    const raw = input[key];
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) fail('VALUE_RANGE', entryPath);
      output[key] = Object.is(raw, -0) ? 0 : raw;
    } else if (typeof raw === 'string') {
      if (raw.length > LIMITS.metricStringValue) fail('VALUE_RANGE', entryPath);
      output[key] = raw;
    } else if (typeof raw === 'boolean') {
      output[key] = raw;
    } else {
      fail('VALUE_TYPE', entryPath);
    }
  }
  return output;
}

export const findingSeverity = enumeration('critical', 'high', 'medium', 'low');
export type FindingSeverity = Infer<typeof findingSeverity>;
export const structuredFindingSchema = record({
  title: text(1, LIMITS.findingTitle),
  severity: findingSeverity,
  path: optional(nullable(nameSchema)),
  line: optional(nullable(integer(1))),
  evidence: text(1, LIMITS.findingEvidence),
});
export type StructuredFinding = Infer<typeof structuredFindingSchema>;
export const findingsSchema = arrayOf(structuredFindingSchema, 0, LIMITS.findings);

export const digestSchema = record({ algorithm: enumeration('sha256'), hex: (value: Json, path: string) => {
  const hex = text(64, 64)(value, path);
  if (!/^[0-9a-f]{64}$/.test(hex)) fail('VALUE_RANGE', path);
  return hex;
} });
export type Digest = Infer<typeof digestSchema>;
export const artifactRefSchema = record({
  name: nameSchema,
  digest: digestSchema,
  byteLength: integer(),
  uri: optional(nullable(artifactUri)),
  mediaType: optional(nullable(mediaType)),
});
export type ArtifactRef = Infer<typeof artifactRefSchema>;

export const reworkPolicySchema = record({
  rejectTo: identifier,
  maxReworks: integer(1, LIMITS.maxReworks),
});
export type ReworkPolicy = Infer<typeof reworkPolicySchema>;

function uniqueArrayOf<T extends string>(schema: Schema<T>, min: number, max: number): Schema<readonly T[]> {
  const base = arrayOf(schema, min, max);
  return (value, path) => {
    const items = base(value, path);
    unique(items, path);
    return items;
  };
}

const handoffHeadingSchema: Schema<string> = (value, path) => {
  const raw = text(1, LIMITS.handoffHeading)(value, path);
  if (/[\r\n\0\p{C}]/u.test(raw) || raw.trim().length === 0) fail('VALUE_RANGE', path);
  const trimmed = raw.trim();
  const headingBody = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(trimmed)?.[2] ?? trimmed;
  const cleaned = headingBody.replace(/[ \t]+$/, '');
  const title = /^#+$/.test(cleaned) ? '' : cleaned.replace(/[ \t]+#+$/, '').trim();
  if (title.length === 0) fail('VALUE_RANGE', path);
  return raw;
};

const jsonPointerSchema: Schema<string> = (value, path) => {
  const pointer = text(0, LIMITS.handoffPointer)(value, path);
  if (/[\0\r\n\p{C}]/u.test(pointer)) fail('VALUE_RANGE', path);
  if (pointer === '') return pointer;
  if (!pointer.startsWith('/')) fail('VALUE_RANGE', path);
  const rawSegments = pointer.slice(1).split('/');
  if (rawSegments.length > LIMITS.segments) fail('VALUE_RANGE', path);
  for (const segment of rawSegments) {
    let decoded = '';
    for (let i = 0; i < segment.length; i++) {
      const ch = segment[i]!;
      if (ch === '~') {
        const next = segment[i + 1];
        if (next === '0') {
          decoded += '~';
          i++;
        } else if (next === '1') {
          decoded += '/';
          i++;
        } else {
          fail('VALUE_RANGE', path);
        }
      } else {
        decoded += ch;
      }
    }
    if (FORBIDDEN_PROTOTYPE_KEYS.has(decoded)) fail('VALUE_RANGE', path);
  }
  return pointer;
};

const handoffArtifactSourceSchema = record({
  kind: enumeration('artifact'),
  path: nameSchema,
});
const handoffSubmissionSourceSchema = record({
  kind: enumeration('submission'),
});
const handoffVerdictSourceSchema = record({
  kind: enumeration('verdict'),
});
export type StepHandoffSource =
  | Infer<typeof handoffArtifactSourceSchema>
  | Infer<typeof handoffSubmissionSourceSchema>
  | Infer<typeof handoffVerdictSourceSchema>;
export const stepHandoffSourceSchema: Schema<StepHandoffSource> = (value, path) => {
  const input = object(value, path);
  if (!Object.hasOwn(input, 'kind')) fail('FIELD_REQUIRED', `${path}/kind`);
  const kind = input.kind;
  if (typeof kind !== 'string') fail('VALUE_TYPE', `${path}/kind`);
  if (kind === 'artifact') return handoffArtifactSourceSchema(input, path);
  if (kind === 'submission') return handoffSubmissionSourceSchema(input, path);
  if (kind === 'verdict') return handoffVerdictSourceSchema(input, path);
  fail('VALUE_ENUM', `${path}/kind`);
};

const handoffMarkdownHeadingSelectSchema = record({
  kind: enumeration('markdown_heading'),
  heading: handoffHeadingSchema,
  includeSubheadings: optional(boolean),
});
const handoffJsonPointerSelectSchema = record({
  kind: enumeration('json_pointer'),
  pointers: uniqueArrayOf(jsonPointerSchema, 1, LIMITS.handoffPointers),
});
const handoffFullSelectSchema = record({
  kind: enumeration('full'),
});
export type StepHandoffSelect =
  | Infer<typeof handoffMarkdownHeadingSelectSchema>
  | Infer<typeof handoffJsonPointerSelectSchema>
  | Infer<typeof handoffFullSelectSchema>;
export const stepHandoffSelectSchema: Schema<StepHandoffSelect> = (value, path) => {
  const input = object(value, path);
  if (!Object.hasOwn(input, 'kind')) fail('FIELD_REQUIRED', `${path}/kind`);
  const kind = input.kind;
  if (typeof kind !== 'string') fail('VALUE_TYPE', `${path}/kind`);
  if (kind === 'markdown_heading') return handoffMarkdownHeadingSelectSchema(input, path);
  if (kind === 'json_pointer') return handoffJsonPointerSelectSchema(input, path);
  if (kind === 'full') return handoffFullSelectSchema(input, path);
  fail('VALUE_ENUM', `${path}/kind`);
};

export const stepHandoffSelectorSchema = record({
  id: optional(identifier),
  fromStep: identifier,
  source: stepHandoffSourceSchema,
  select: stepHandoffSelectSchema,
  maxBytes: optional(integer(LIMITS.handoffMinBytes, LIMITS.handoffMaxBytes)),
  required: optional(boolean),
});
export type StepHandoffSelector = Infer<typeof stepHandoffSelectorSchema>;

const resourceExtensionSchema: Schema<string> = (value, path) => {
  const ext = text(2, LIMITS.ruleExtension)(value, path);
  if (!/^\.[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/.test(ext)) fail('VALUE_RANGE', path);
  return ext;
};

const failureCodeSchema: Schema<string> = (value, path) => {
  const codeValue = text(1, LIMITS.ruleFailureCode)(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(codeValue)) fail('IDENTIFIER_INVALID', path);
  return codeValue;
};

export const resourceActivationPhase = enumeration('author', 'review', 'repair', 'rework');
export type ResourceActivationPhase = Infer<typeof resourceActivationPhase>;

const resourceActivationRuleShape = record({
  changedPaths: optional(uniqueArrayOf(pattern, 1, LIMITS.ruleChangedPaths)),
  extensions: optional(uniqueArrayOf(resourceExtensionSchema, 1, LIMITS.ruleExtensions)),
  phases: optional(uniqueArrayOf(resourceActivationPhase, 1, LIMITS.rulePhases)),
  failedChecks: optional(uniqueArrayOf(identifier, 1, LIMITS.ruleFailedChecks)),
  failureCodes: optional(uniqueArrayOf(failureCodeSchema, 1, LIMITS.ruleFailureCodes)),
});
export type ResourceActivationRule = Infer<typeof resourceActivationRuleShape>;
export const resourceActivationRuleSchema: Schema<ResourceActivationRule> = (value, path) => {
  const parsed = resourceActivationRuleShape(value, path);
  if (Object.keys(parsed).length === 0) fail('VALUE_RANGE', path);
  return parsed;
};

function isCompactionUses(uses: string): boolean {
  return uses === 'pi.compact.v1';
}

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
const overlaySchema = record({
  maxFiles: integer(OVERLAY_LIMITS.minMaxFiles, OVERLAY_LIMITS.maxMaxFiles),
  maxBytes: integer(OVERLAY_LIMITS.minMaxBytes, OVERLAY_LIMITS.maxMaxBytes),
});
const mode = enumeration('hard_admission', 'soft_accounting');
const budgets = record({
  wallTimeMs: integer(1), totalTokens: integer(1), perCallOutputTokens: integer(1),
  maxModelCalls: integer(1), maxConcurrency: integer(1), maxFormatRepairs: integer(),
  maxImplementationRepairs: integer(), maxTransportRetries: integer(),
  enforcement: record({ wallTime: mode, tokens: mode, modelCalls: mode, concurrency: mode,
    formatRepairs: mode, implementationRepairs: mode, transportRetries: mode }),
  overlay: optional(overlaySchema),
});
const taskShape = configDocument('TaskContract', record({
  goal: text(1, LIMITS.goal), taskpack: identifier,
  target: record({ repository, baseRevision: revision, sourceRevision: revision,
    matrix: nullable(arrayOf(record({ id: identifier, platform: label, variant: label }), 1, LIMITS.targets)) }),
  scope: record({ writable: arrayOf(pattern, 1, LIMITS.patterns), protected: arrayOf(pattern, 0, LIMITS.patterns) }),
  roles: arrayOf(record({ id: identifier, adapter: label, provider: label, model: label, thinking: label,
    tools: arrayOf(toolName, 0, LIMITS.tools),
    resourceIds: optional(arrayOf(identifier, 0, LIMITS.resources)),
  }), 1, LIMITS.roles),
  trustedContext: record({ revision, discovery: enumeration('disabled'), resources: arrayOf(record({
    id: identifier, kind: enumeration('instruction', 'skill', 'document'), path: nameSchema, digest: digestSchema,
    when: optional(resourceActivationRuleSchema),
  }), 0, LIMITS.resources) }),
  budgets,
  steps: arrayOf(record({ id: identifier, kind: enumeration('agent', 'check'), uses: identifier,
    roleId: nullable(identifier), dependsOn: arrayOf(identifier),
    onRework: optional(reworkPolicySchema),
    handoffs: optional(arrayOf(stepHandoffSelectorSchema, 1, LIMITS.handoffsPerStep)),
  }), 1),
  acceptance: record({ required: arrayOf(identifier, 1, LIMITS.checks), checks: arrayOf(record({
    id: identifier, allowedEvidenceLevels: arrayOf(evidenceLevel, 1, 5),
  }), 1, LIMITS.checks) }),
}));
export type TaskContract = Infer<typeof taskShape>;

function strictAncestors(
  stepId: string,
  dependenciesByStep: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  const pending = [...(dependenciesByStep.get(stepId) ?? [])];
  while (pending.length) {
    const current = pending.pop()!;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    for (const parent of dependenciesByStep.get(current) ?? []) pending.push(parent);
  }
  return ancestors;
}

export function contractSchema(input: Json, path = ''): TaskContract {
  const value = taskShape(input, path), spec = value.spec;
  const rolesPath = `${path}/spec/roles`, stepsPath = `${path}/spec/steps`;
  unique(spec.roles.map(role => role.id), rolesPath);
  spec.roles.forEach((role, index) => {
    unique(role.tools, `${rolesPath}/${index}/tools`);
    if (role.resourceIds !== undefined) unique(role.resourceIds, `${rolesPath}/${index}/resourceIds`);
  });
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
  const resourceIds = new Set(spec.trustedContext.resources.map(item => item.id));
  spec.roles.forEach((role, index) => {
    role.resourceIds?.forEach((resourceId, resourceIndex) => {
      if (!resourceIds.has(resourceId)) fail('REFERENCE_UNKNOWN', `${rolesPath}/${index}/resourceIds/${resourceIndex}`);
    });
  });
  const roleIds = new Set(spec.roles.map(role => role.id));
  const stepIds = new Set(spec.steps.map(step => step.id));
  spec.steps.forEach((step, index) => {
    if (step.roleId === null ? step.kind === 'agent' : !roleIds.has(step.roleId)) fail('REFERENCE_UNKNOWN', `${stepsPath}/${index}/roleId`);
    if (step.onRework !== undefined && !stepIds.has(step.onRework.rejectTo)) fail('REFERENCE_UNKNOWN', `${stepsPath}/${index}/onRework/rejectTo`);
    if (step.handoffs !== undefined) {
      if (step.kind !== 'agent' || isCompactionUses(step.uses)) fail('FIELD_UNKNOWN', `${stepsPath}/${index}/handoffs`);
      const seenHandoffIds = new Set<string>();
      let aggregateBytes = 0;
      step.handoffs.forEach((handoff, handoffIndex) => {
        const handoffPath = `${stepsPath}/${index}/handoffs/${handoffIndex}`;
        if (handoff.id !== undefined) {
          if (seenHandoffIds.has(handoff.id)) fail('DUPLICATE_ID', `${handoffPath}/id`);
          seenHandoffIds.add(handoff.id);
        }
        aggregateBytes += handoff.maxBytes ?? LIMITS.handoffDefaultBytes;
        if (aggregateBytes > LIMITS.handoffAggregateBytes) fail('VALUE_RANGE', handoffPath);
        if (!stepIds.has(handoff.fromStep)) fail('REFERENCE_UNKNOWN', `${handoffPath}/fromStep`);
      });
    }
  });
  validateGraph(spec.steps, stepsPath);
  const dependenciesByStep = new Map(spec.steps.map(step => [step.id, step.dependsOn] as const));
  spec.steps.forEach((step, index) => {
    if (step.onRework === undefined && step.handoffs === undefined) return;
    const ancestors = strictAncestors(step.id, dependenciesByStep);
    if (step.onRework !== undefined && !ancestors.has(step.onRework.rejectTo)) {
      fail('GRAPH_CYCLE', `${stepsPath}/${index}/onRework/rejectTo`);
    }
    if (step.handoffs !== undefined) {
      step.handoffs.forEach((handoff, handoffIndex) => {
        if (!ancestors.has(handoff.fromStep)) fail('GRAPH_CYCLE', `${stepsPath}/${index}/handoffs/${handoffIndex}/fromStep`);
      });
    }
  });
  const budget = spec.budgets;
  if (budget.perCallOutputTokens > budget.totalTokens || budget.maxConcurrency > budget.maxModelCalls
    || budget.maxFormatRepairs > budget.maxModelCalls || budget.maxImplementationRepairs > budget.maxModelCalls
    || budget.maxTransportRetries > budget.maxModelCalls) fail('BUDGET_INCONSISTENT', `${path}/spec/budgets`);
  return value;
}

const overlayLimitsShape = record({
  maxFiles: optional(integer(OVERLAY_LIMITS.minMaxFiles, OVERLAY_LIMITS.maxMaxFiles)),
  maxBytes: optional(integer(OVERLAY_LIMITS.minMaxBytes, OVERLAY_LIMITS.maxMaxBytes)),
});
const overlayOptionsShape = record({
  overlay: optional(overlayLimitsShape),
});

export function resolveOverlayOptions(options?: unknown): OverlayLimits | undefined {
  if (options === undefined) return undefined;
  const parsed = overlayOptionsShape(object(snapshot({ options }), '').options!, '/options');
  if (parsed.overlay === undefined) return undefined;
  return {
    maxFiles: parsed.overlay.maxFiles ?? OVERLAY_LIMITS.defaultMaxFiles,
    maxBytes: parsed.overlay.maxBytes ?? OVERLAY_LIMITS.defaultMaxBytes,
  };
}

export function resolveOverlayLimits(input?: unknown): Result<OverlayLimits> {
  return attempt(() => {
    if (input === undefined) {
      return { maxFiles: OVERLAY_LIMITS.defaultMaxFiles, maxBytes: OVERLAY_LIMITS.defaultMaxBytes };
    }
    const parsed = overlayLimitsShape(object(snapshot({ input }), '').input!, '');
    return {
      maxFiles: parsed.maxFiles ?? OVERLAY_LIMITS.defaultMaxFiles,
      maxBytes: parsed.maxBytes ?? OVERLAY_LIMITS.defaultMaxBytes,
    };
  });
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
