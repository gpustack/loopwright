export const DEFAULT_MAX_DISPATCH_TURNS = 40;
export const DEFAULT_MAX_REPAIR_DISPATCH_TURNS = 20;

export function deriveDefaultCircuitBreakerLimits(
  budgets: { readonly maxModelCalls: number; readonly maxImplementationRepairs: number },
  policyRequests?: number,
): { readonly maxTurns: number; readonly maxRepairTurns: number } {
  const effectiveBudget = Math.max(
    1,
    policyRequests !== undefined
      ? Math.min(budgets.maxModelCalls, policyRequests)
      : budgets.maxModelCalls,
  );
  const maxTurns = effectiveBudget <= DEFAULT_MAX_DISPATCH_TURNS || budgets.maxImplementationRepairs === 0
    ? effectiveBudget
    : Math.min(effectiveBudget, Math.max(DEFAULT_MAX_DISPATCH_TURNS, Math.floor(effectiveBudget * 0.75)));
  const maxRepairTurns = Math.min(
    effectiveBudget,
    Math.max(DEFAULT_MAX_REPAIR_DISPATCH_TURNS, Math.floor(effectiveBudget / 4)),
  );
  return Object.freeze({ maxTurns, maxRepairTurns });
}
