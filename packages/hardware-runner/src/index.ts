export const HARDWARE_RUNNER_PACKAGE_NAME = '@loopwright/hardware-runner' as const;
export const HARDWARE_RUNNER_SCAFFOLD_VERSION = 1 as const;

export interface HardwareRunnerDescriptor {
  readonly name: typeof HARDWARE_RUNNER_PACKAGE_NAME;
  readonly version: typeof HARDWARE_RUNNER_SCAFFOLD_VERSION;
}
