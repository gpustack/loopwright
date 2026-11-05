import { fail } from './diagnostics.js';
import { LIMITS } from './limits.js';

export function unique(values: readonly string[], path: string, code: 'DUPLICATE_ID' | 'DUPLICATE_EDGE' = 'DUPLICATE_ID'): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) fail(code, `${path}/${index}`);
    seen.add(value);
  });
}
type Steps = readonly { readonly id: string; readonly dependsOn: readonly string[] }[];
export function graphBounds(steps: Steps, path: string): void {
  if (steps.length > LIMITS.graphNodes) fail('LIMIT_GRAPH_NODES', path);
  unique(steps.map(step => step.id), path);
  let edges = 0;
  steps.forEach((step, index) => {
    unique(step.dependsOn, `${path}/${index}/dependsOn`, 'DUPLICATE_EDGE');
    edges += step.dependsOn.length;
    if (edges > LIMITS.graphEdges) fail('LIMIT_GRAPH_EDGES', path);
  });
}
export function validateGraph(steps: Steps, path: string): void {
  graphBounds(steps, path);
  const indexes = new Map(steps.map((step, index) => [step.id, index]));
  const indegrees = steps.map(step => step.dependsOn.length);
  const children: number[][] = steps.map(() => []);
  steps.forEach((step, index) => step.dependsOn.forEach((dependency, edge) => {
    const parent = indexes.get(dependency);
    if (parent === undefined) fail('REFERENCE_UNKNOWN', `${path}/${index}/dependsOn/${edge}`);
    children[parent]!.push(index);
  }));
  const queue = indegrees.flatMap((count, index) => count === 0 ? [index] : []);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const child of children[queue[cursor]!]!) {
      indegrees[child]!--;
      if (indegrees[child] === 0) queue.push(child);
    }
  }
  if (queue.length !== steps.length) fail('GRAPH_CYCLE', path);
}
