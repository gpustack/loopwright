export const LIMITS = Object.freeze({
  inputBytes: 1_048_576, depth: 64, string: 16_384, nodes: 65_536,
  properties: 128, collection: 1_024, identifier: 64, toolName: 128,
  goal: 4_096, path: 1_024, segments: 64, roles: 64, resources: 128,
  tools: 128, patterns: 128, targets: 64, graphNodes: 256, graphEdges: 2_048,
  checks: 256, evidence: 256, manifest: 256, requests: 1_024,
  resolvedArtifacts: 512, artifactBytes: 8_388_608, resolvedBytes: 16_777_216,
});
