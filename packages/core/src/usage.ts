import { snapshot, type Json } from './boundary.js';
import { arrayOf, enumeration, identifier, integer, object, record, type Infer, type Schema } from './contracts.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { unique } from './graph.js';
import { LIMITS } from './limits.js';

const knownQuantity = record({ provenance: enumeration('reported', 'estimated'), value: integer() });
const unknownQuantity = record({ provenance: enumeration('unknown') });
export type Quantity = Infer<typeof knownQuantity> | Infer<typeof unknownQuantity>;
const quantitySchema: Schema<Quantity> = (input, path) => {
  const value = object(input, path);
  if (value.provenance === 'unknown') return unknownQuantity(input, path);
  return knownQuantity(input, path);
};
const requestSchema = record({ requestId: identifier, inputTokens: quantitySchema, outputTokens: quantitySchema, costMicrousd: quantitySchema });
export type RequestUsage = Infer<typeof requestSchema>;
export const requestsSchema = arrayOf(requestSchema, 0, LIMITS.requests);
const aggregateSchema = record({ knownSubtotal: integer(), unknownCount: integer(), completeness: enumeration('complete', 'partial'), provenance: enumeration('reported', 'estimated', 'unknown') });
export type Aggregate = Infer<typeof aggregateSchema>;
const summaryShape = record({ requests: requestsSchema, inputTokens: aggregateSchema, outputTokens: aggregateSchema, totalTokens: aggregateSchema, costMicrousd: aggregateSchema });
export type UsageSummary = Infer<typeof summaryShape>;

function aggregate(quantities: readonly Quantity[], path: string): Aggregate {
  let knownSubtotal = 0, unknownCount = 0, estimated = false;
  for (const quantity of quantities) {
    if (quantity.provenance === 'unknown') { unknownCount++; continue; }
    if (quantity.value > Number.MAX_SAFE_INTEGER - knownSubtotal) fail('USAGE_OVERFLOW', path);
    knownSubtotal += quantity.value;
    if (quantity.provenance === 'estimated') estimated = true;
  }
  const allUnknown = quantities.length > 0 && unknownCount === quantities.length;
  return { knownSubtotal, unknownCount, completeness: unknownCount ? 'partial' : 'complete',
    provenance: allUnknown ? 'unknown' : estimated ? 'estimated' : 'reported' };
}
export function summarizeRequests(requests: readonly RequestUsage[], path: string): UsageSummary {
  unique(requests.map(request => request.requestId), path);
  return { requests,
    inputTokens: aggregate(requests.map(request => request.inputTokens), path),
    outputTokens: aggregate(requests.map(request => request.outputTokens), path),
    totalTokens: aggregate(requests.flatMap(request => [request.inputTokens, request.outputTokens]), path),
    costMicrousd: aggregate(requests.map(request => request.costMicrousd), path),
  };
}
export function usageSummarySchema(input: Json, path: string): UsageSummary {
  const summary = summaryShape(input, path), expected = summarizeRequests(summary.requests, `${path}/requests`);
  for (const metric of ['inputTokens', 'outputTokens', 'totalTokens', 'costMicrousd'] as const) {
    for (const field of ['knownSubtotal', 'unknownCount', 'completeness', 'provenance'] as const) {
      if (summary[metric][field] !== expected[metric][field]) fail('VALUE_RANGE', `${path}/${metric}/${field}`);
    }
  }
  return summary;
}
export function aggregateUsage(input: unknown): Result<UsageSummary> {
  return attempt(() => summarizeRequests(requestsSchema(snapshot(input), ''), ''));
}
