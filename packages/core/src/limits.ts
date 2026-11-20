export const OVERLAY_LIMITS = Object.freeze({
  defaultMaxFiles: 128,
  defaultMaxBytes: 4_194_304,
  minMaxFiles: 1,
  minMaxBytes: 1_024,
  maxMaxFiles: 16_384,
  maxMaxBytes: 17_179_869_184,
});

export interface OverlayLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

export interface OverlayLimitsInput {
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface OverlayLimitOptions {
  readonly overlay?: OverlayLimitsInput;
}

export const LIMITS = Object.freeze({
  inputBytes: 1_048_576, depth: 64, string: 16_384, nodes: 65_536,
  properties: 128, collection: 1_024, identifier: 64, toolName: 128,
  goal: 4_096, path: 1_024, segments: 64, roles: 64, resources: 128,
  tools: 128, patterns: 128, patternWildcards: 16, targets: 64, graphNodes: 256, graphEdges: 2_048,
  checks: 256, evidence: 256, manifest: 256, overlayEntries: 128, baselineEntries: 65_536, requests: 1_024,
  resolvedArtifacts: 512, artifactBytes: 67_108_864, resolvedBytes: 134_217_728,
  metricEntries: 64, metricKey: 64, metricStringValue: 256,
  findings: 64, findingTitle: 256, findingEvidence: 2_048,
  artifactUri: 2_048, mediaType: 128, maxReworks: 8,
});
