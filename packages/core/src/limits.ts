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

export const HANDOFF_LIMITS = Object.freeze({
  maxPerStep: 16,
  maxPointers: 32,
  minBytes: 64,
  defaultBytes: 8_192,
  maxBytes: 65_536,
  maxAggregateBytes: 65_536,
  maxSourceBytes: 1_048_576,
  maxHeadingChars: 256,
  maxPointerChars: 512,
});

export const VERIFIER_ARTIFACT_LIMITS = Object.freeze({
  prefix: '.loopwright-verifier',
  maxFilesPerSlot: 64,
  maxTotalFiles: 256,
  maxFileBytes: OVERLAY_LIMITS.maxMaxBytes,
  maxTotalBytes: OVERLAY_LIMITS.maxMaxBytes,
});

export const LIMITS = Object.freeze({
  inputBytes: 1_048_576, depth: 64, string: 16_384, nodes: 65_536,
  properties: 128, collection: 1_024, identifier: 64, toolName: 128,
  goal: 4_096, path: 1_024, segments: 64, roles: 64, resources: 128,
  tools: 128, patterns: 128, patternWildcards: 16, targets: 64, graphNodes: 256, graphEdges: 2_048,
  checks: 256, evidence: 256, manifest: 256, overlayEntries: 128, baselineEntries: 65_536, requests: 1_024,
  resolvedArtifacts: 512, artifactBytes: 67_108_864, resolvedBytes: 134_217_728,
  metricEntries: 64, metricKey: 64, metricStringValue: 256, metricThresholds: 32,
  forbiddenSymbolPatterns: 64, forbiddenSymbolPattern: 128,
  bucketMetrics: 64, bucketId: 64, bucketMetricEntries: 16,
  bucketDimensionEntries: 8, bucketDimensionStringValue: 64,
  hardwareStallReasons: 16, hardwareStallReason: 64,
  findings: 64, findingTitle: 256, findingEvidence: 2_048,
  artifactUri: 2_048, mediaType: 128, maxReworks: 8,
  handoffsPerStep: HANDOFF_LIMITS.maxPerStep,
  handoffPointers: HANDOFF_LIMITS.maxPointers,
  handoffMinBytes: HANDOFF_LIMITS.minBytes,
  handoffDefaultBytes: HANDOFF_LIMITS.defaultBytes,
  handoffMaxBytes: HANDOFF_LIMITS.maxBytes,
  handoffAggregateBytes: HANDOFF_LIMITS.maxAggregateBytes,
  handoffSourceBytes: HANDOFF_LIMITS.maxSourceBytes,
  handoffHeading: HANDOFF_LIMITS.maxHeadingChars,
  handoffPointer: HANDOFF_LIMITS.maxPointerChars,
  ruleChangedPaths: 128,
  ruleExtensions: 64,
  ruleExtension: 33,
  rulePhases: 4,
  ruleFailedChecks: 64,
  ruleFailureCodes: 64,
  ruleFailureCode: 128,
  suiteDomains: 32,
  suiteStages: 16,
  suiteManifestBytes: 65_536,
  baselineMaxConflictFiles: 64,
  baselineMinConflictBytes: 1_024,
  baselineMaxConflictBytes: 262_144,
});
