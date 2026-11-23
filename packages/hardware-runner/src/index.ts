export const HARDWARE_RUNNER_PACKAGE_NAME = '@loopwright/hardware-runner' as const;
export const HARDWARE_RUNNER_SCAFFOLD_VERSION = 1 as const;

export interface HardwareRunnerDescriptor {
  readonly name: typeof HARDWARE_RUNNER_PACKAGE_NAME;
  readonly version: typeof HARDWARE_RUNNER_SCAFFOLD_VERSION;
}

export {
  HARDWARE_BOUND_PIPELINES,
  STAGE_A_STATIC_AUDIT_FAILED,
  validateBucketMetrics,
  validateHardwareDiagnostics,
} from '@loopwright/core';
export * from './types.js';
export * from './config.js';
export * from './queue.js';
export * from './relay-server.js';
export * from './provenance.js';
export * from './evaluator.js';
export * from './worker.js';
