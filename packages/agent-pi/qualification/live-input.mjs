/* global structuredClone */
import { admitTask } from '@loopwright/core';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { liveRefusal } from './live-budget.mjs';
/** Fixed synthetic local probe data; caller supplies an explicit ready token separately. */
export function liveInput(model) {
 if (!['claude-sonnet-5.5', 'claude-opus-5.5'].includes(model)) throw liveRefusal('LIVE_POLICY_INVALID');
 const base = sessionInput(), task = structuredClone(base.lock.spec.contract); task.spec.budgets = { ...task.spec.budgets, wallTimeMs: 3600000, maxModelCalls: 8, maxConcurrency: 1, maxTransportRetries: 0 };
 task.spec.roles.push({ ...structuredClone(task.spec.roles[0]), id: 'opus', model: 'claude-opus-5.5', thinking: 'high' }); task.spec.steps.push({ ...structuredClone(task.spec.steps[0]), id: 'opus-step', roleId: 'opus' });
 const lock = admitTask(task, { admissionId: 'live-admission', runId: 'live-s03' }); if (!lock.ok) throw liveRefusal('LIVE_POLICY_INVALID'); base.lock = lock.value;
 if (model === 'claude-opus-5.5') { base.roleId = 'opus'; base.stepId = 'opus-step'; base.policy.selection.model = model; base.policy.selection.thinking = 'high'; }
 base.policy.context.mode = 'estimated_guard'; base.policy.context.maxOutputTokens = 1024; base.sessionId = model === 'claude-opus-5.5' ? 'live-opus' : 'live-sonnet'; return base;
}
