import { posix } from 'node:path';
import {
  matchesScopePattern,
  validateScopePattern,
  type ResourceActivationPhase,
  type ResourceActivationRule,
} from '@loopwright/core';
import { freeze, isRecord } from './schema.js';

export interface EvaluableResource {
  readonly id: string;
  readonly when?: ResourceActivationRule | undefined;
}

export interface RuleEvaluationContext {
  readonly repair?: 'none' | 'format' | 'implementation' | undefined;
  readonly reworkEpoch?: number | undefined;
  readonly purpose?: 'task' | 'reviewer' | 'compaction' | undefined;
  readonly isReviewer?: boolean | undefined;
  readonly phase?: ResourceActivationPhase | undefined;
  readonly changedPaths?: readonly string[] | undefined;
  readonly watchedPaths?: readonly string[] | undefined;
  readonly failedChecks?: readonly string[] | undefined;
  readonly failureCodes?: readonly string[] | undefined;
}

function matchesGlobPattern(pattern: string, candidatePath: string): boolean {
  if (!validateScopePattern(pattern).ok) return false;
  const matched = matchesScopePattern(pattern, candidatePath);
  return matched.ok ? matched.value : false;
}

function matchesNormalizedExtension(candidatePath: string, rawExtension: string): boolean {
  if (typeof candidatePath !== 'string' || typeof rawExtension !== 'string' || rawExtension.length === 0) return false;
  const normalizedExt = rawExtension.startsWith('.') ? rawExtension.toLowerCase() : '.' + rawExtension.toLowerCase();
  if (normalizedExt.length < 2) return false;
  const base = posix.basename(candidatePath).toLowerCase();
  return base.length > normalizedExt.length && base.endsWith(normalizedExt);
}

/**
 * Deterministic phase precedence:
 * 1. `repair === 'format'` -> `'format'` (mounts zero conditional rules; keeps unconditional resources)
 * 2. `repair === 'implementation'` -> `'repair'`
 * 3. active rework (`reworkEpoch > 0`) -> `'rework'`
 * 4. reviewer step/role -> `'review'`
 * 5. otherwise -> `context.phase ?? 'author'`
 */
export function resolveActivationPhase(context: RuleEvaluationContext): ResourceActivationPhase | 'format' {
  if (context.repair === 'format') return 'format';
  if (context.repair === 'implementation') return 'repair';
  if ((context.reworkEpoch ?? 0) > 0) return 'rework';
  if (context.isReviewer === true || context.purpose === 'reviewer') return 'review';
  return context.phase ?? 'author';
}

function matchesActivationRule(
  when: ResourceActivationRule,
  activePhase: ResourceActivationPhase,
  effectivePaths: readonly string[],
  failedCheckSet: ReadonlySet<string>,
  failureCodeSet: ReadonlySet<string>,
): boolean {
  if (!isRecord(when)) return false;
  const hasChangedPaths = Object.hasOwn(when, 'changedPaths') && when.changedPaths !== undefined;
  const hasExtensions = Object.hasOwn(when, 'extensions') && when.extensions !== undefined;
  const hasPhases = Object.hasOwn(when, 'phases') && when.phases !== undefined;
  const hasFailedChecks = Object.hasOwn(when, 'failedChecks') && when.failedChecks !== undefined;
  const hasFailureCodes = Object.hasOwn(when, 'failureCodes') && when.failureCodes !== undefined;

  if (!hasChangedPaths && !hasExtensions && !hasPhases && !hasFailedChecks && !hasFailureCodes) {
    return false;
  }
  if (hasPhases) {
    const phases = when.phases!;
    if (!Array.isArray(phases) || !phases.includes(activePhase)) return false;
  }
  if (hasChangedPaths) {
    const patterns = when.changedPaths!;
    if (
      !Array.isArray(patterns)
      || effectivePaths.length === 0
      || !patterns.some(pattern => effectivePaths.some(candidatePath => matchesGlobPattern(pattern, candidatePath)))
    ) {
      return false;
    }
  }
  if (hasExtensions) {
    const extensions = when.extensions!;
    if (
      !Array.isArray(extensions)
      || effectivePaths.length === 0
      || !extensions.some(ext => effectivePaths.some(candidatePath => matchesNormalizedExtension(candidatePath, ext)))
    ) {
      return false;
    }
  }
  if (hasFailedChecks) {
    const checks = when.failedChecks!;
    if (!Array.isArray(checks) || failedCheckSet.size === 0 || !checks.some(checkId => failedCheckSet.has(checkId))) {
      return false;
    }
  }
  if (hasFailureCodes) {
    const codes = when.failureCodes!;
    if (!Array.isArray(codes) || failureCodeSet.size === 0 || !codes.some(code => failureCodeSet.has(code))) {
      return false;
    }
  }
  return true;
}

/**
 * Deterministically filter `TaskContract` resources for a single attempt, preserving declaration order.
 * Unconditional resources (`when === undefined`) are always active; conditional resources combine
 * declared predicate fields via logical `AND` and items within each list field via logical `OR`.
 */
export function evaluateResourceActivationRules<T extends EvaluableResource>(
  resources: readonly T[],
  context: RuleEvaluationContext,
): readonly T[] {
  const activePhase = resolveActivationPhase(context);
  const candidatePaths = context.changedPaths ?? [];
  const effectivePaths = candidatePaths.length > 0 ? candidatePaths : (context.watchedPaths ?? []);
  const failedCheckSet = new Set(context.failedChecks ?? []);
  const failureCodeSet = new Set(context.failureCodes ?? []);

  const selected: T[] = [];
  for (const resource of resources) {
    const hasWhen = isRecord(resource) && Object.hasOwn(resource, 'when') && resource.when !== undefined;
    if (!hasWhen) {
      selected.push(resource);
      continue;
    }
    if (activePhase === 'format') {
      continue;
    }
    if (matchesActivationRule(resource.when!, activePhase, effectivePaths, failedCheckSet, failureCodeSet)) {
      selected.push(resource);
    }
  }
  return freeze(selected);
}
