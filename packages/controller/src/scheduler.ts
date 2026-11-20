import { refuse } from './errors.js';
import { freeze } from './schema.js';
import type { CompiledPlan, ControllerProgress } from './types.js';
type Node = CompiledPlan['orderedDAG'][number];
export function descendants(plan: Pick<CompiledPlan, 'orderedDAG'>, id: string): readonly string[] {
  const found = new Set<string>();
  for (const node of plan.orderedDAG) if (node.dependsOn.some(parent => parent === id || found.has(parent))) found.add(node.id);
  return [...found];
}
/** Deterministic topological slice `[rejectToId, ...strictDescendants]` for targeted rework resets. */
export function reworkSubgraph(plan: Pick<CompiledPlan, 'orderedDAG'>, rejectToId: string): readonly string[] {
  if (!plan.orderedDAG.some(node => node.id === rejectToId)) refuse('CONFIG_REFERENCE', '/spec/task/spec/steps', 'compile');
  const targetSet = new Set<string>([rejectToId, ...descendants(plan, rejectToId)]);
  return freeze(plan.orderedDAG.filter(node => targetSet.has(node.id)).map(node => node.id));
}
export function resetSubgraphNodes(
  plan: Pick<CompiledPlan, 'orderedDAG'>,
  states: ControllerProgress['nodes'],
  rejectToId: string,
): ControllerProgress['nodes'] {
  const resetIds = new Set(reworkSubgraph(plan, rejectToId));
  return freeze(states.map(item => (resetIds.has(item.id) ? { id: item.id, state: 'pending' as const } : { ...item })));
}
export function nextNode(plan: CompiledPlan, states: ControllerProgress['nodes']): Node | null {
  return plan.orderedDAG.find(node => states.find(item => item.id === node.id)?.state === 'pending'
    && node.dependsOn.every(parent => states.find(item => item.id === parent)?.state === 'completed')) ?? null;
}
/** The empty compact handler has no task-selected session ID: require one maximal ordinary ancestor. */
export function compactionTarget(plan: Pick<CompiledPlan, 'orderedDAG'>, id: string): string {
  const node = plan.orderedDAG.find(item => item.id === id); if (!node || node.handler.implementation !== 'pi.compact.v1') refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile');
  const ancestors = new Set<string>();
  const visit = (id: string): void => { if (ancestors.has(id)) return; ancestors.add(id); for (const parent of plan.orderedDAG.find(item => item.id === id)!.dependsOn) visit(parent); };
  for (const parent of node.dependsOn) visit(parent);
  const candidates = plan.orderedDAG.filter(item => ancestors.has(item.id) && item.kind === 'agent' && item.roleId === node.roleId && item.handler.implementation === 'pi.agent.v1');
  const maximal = candidates.filter(item => !candidates.some(other => other.id !== item.id && descendants(plan, item.id).includes(other.id)));
  if (maximal.length !== 1) refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile'); return maximal[0]!.id;
}
