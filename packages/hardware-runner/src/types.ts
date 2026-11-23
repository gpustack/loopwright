import type {
  BaseTreeAnchor,
  BucketDimensionValue,
  BucketDimensionsMap,
  BucketMetricEntry,
  Digest,
  HardwareBoundPipeline,
  HardwareDiagnostics,
  HardwareProvenance,
  HardwareStallReason,
  HardwareTargetSpec,
  MetricBucketScope,
  MetricThresholdRule,
  MetricsMap,
  StructuredFinding,
  Subject,
} from '@loopwright/core';

export type {
  BucketDimensionValue,
  BucketDimensionsMap,
  BucketMetricEntry,
  HardwareBoundPipeline,
  HardwareDiagnostics,
  HardwareStallReason,
  MetricBucketScope,
};

export type HardwareDiagnosticsSummary = HardwareDiagnostics;

export type HardwareRunnerErrorCode =
  | 'CONFIG_INVALID'
  | 'QUEUE_LEASE_FENCED'
  | 'QUEUE_STATE_INVALID'
  | 'QUEUE_CAPACITY_EXCEEDED'
  | 'QUEUE_JOB_CONFLICT'
  | 'ARTIFACT_INVALID'
  | 'ARTIFACT_MISSING'
  | 'AUTH_UNAUTHORIZED'
  | 'AUTH_FORBIDDEN'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOT_FOUND'
  | 'RUNNER_SANDBOX_FAILED'
  | 'WORKER_DEVICE_QUARANTINED';

export interface StageAStaticAuditSpec {
  readonly forbiddenSymbolPatterns?: readonly string[];
  readonly maxRegisterCount?: number;
  readonly maxLocalSpillBytes?: number;
}

export type AcceleratorFaultKind =
  | 'xid_error'
  | 'ecc_uncorrectable'
  | 'row_remap_failure'
  | 'gpu_reset_required'
  | 'device_lost'
  | 'probe_timeout'
  | 'probe_failed'
  | 'health_degraded';

export interface AcceleratorHealthProbeResult {
  readonly healthy: boolean;
  readonly quarantineRequired: boolean;
  readonly probeKind: 'physical' | 'synthetic_fixture';
  readonly vendor: 'nvidia' | 'amd' | 'huawei' | 'synthetic';
  readonly checkedDeviceIndices: readonly number[];
  readonly faultKind?: AcceleratorFaultKind;
  readonly externalHostLoss?: boolean;
  readonly summary: string;
  readonly findings: readonly StructuredFinding[];
}

export class HardwareRunnerError extends Error {
  readonly code: HardwareRunnerErrorCode;
  readonly path?: string;

  constructor(code: HardwareRunnerErrorCode, message: string, path?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HardwareRunnerError';
    this.code = code;
    if (path !== undefined) {
      this.path = path;
    }
  }
}

export interface ClockSource {
  nowMonotonicMs(): number;
  nowWallMs(): number;
}

export interface RelayTlsConfig {
  readonly certPath: string;
  readonly keyPath: string;
  readonly caPath?: string;
}

export interface RelayConfig {
  readonly host: string;
  readonly port: number;
  readonly casDir: string;
  readonly controllerSigningSecret: string;
  readonly controllerAuthToken?: string;
  readonly workerTokens: readonly string[];
  readonly leaseTtlMs: number;
  readonly sweepIntervalMs: number;
  readonly verdictTtlMs: number;
  readonly maxBlobBytes: number;
  readonly maxJobs: number;
  readonly maxRetainedTerminalOps?: number;
  readonly tls: RelayTlsConfig | false;
}

export interface RelayServerOptions {
  readonly host?: string;
  readonly port: number;
  readonly casDir: string;
  readonly controllerSigningSecret: string;
  readonly controllerAuthToken?: string;
  readonly workerTokens: readonly string[];
  readonly leaseTtlMs?: number;
  readonly sweepIntervalMs?: number;
  readonly verdictTtlMs?: number;
  readonly maxBlobBytes?: number;
  readonly maxJobs?: number;
  readonly maxRetainedTerminalOps?: number;
  readonly tls?: RelayTlsConfig | false;
  readonly clock?: ClockSource;
  readonly onBeforeReceiptPersist?: (operationId: string) => void | Promise<void>;
  readonly onBeforeOperationPersist?: (operationId: string) => void | Promise<void>;
  readonly onBeforeFenceUpdate?: (operationId: string, reason: string) => void;
}

export interface WorkerCapabilities {
  readonly accelerator: string;
  readonly isolationModes: readonly ('whole_device' | 'sliced')[];
  readonly deviceCount: number;
  readonly driverVersion: string;
  readonly topology?: string;
  readonly workloadIds?: readonly string[];
}

export interface WorkerConfig {
  readonly workerId: string;
  readonly relayUrl: string;
  readonly workerToken: string;
  readonly workDir: string;
  readonly heldOutWorkloadsDir: string;
  readonly sandboxBackend: 'native_os' | 'docker';
  readonly dockerImage?: string;
  readonly capabilities: WorkerCapabilities;
  readonly pollWaitMs: number;
  readonly heartbeatIntervalMs: number;
  readonly requestTimeoutMs: number;
  readonly stageATimeoutMs: number;
  readonly stageBTimeoutMs: number;
  readonly toolchainPaths: readonly string[];
  readonly probeMode: 'physical' | 'synthetic_fixture';
  readonly tlsCaPath?: string;
}

export interface BenchmarkCandidateEntry {
  readonly name: string;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly mode?: '100644' | '100755';
}

export interface BenchmarkBaseTreeBundle {
  readonly digest: Digest;
  readonly byteLength: number;
}

export interface BenchmarkCandidateArtifacts {
  readonly entries: readonly BenchmarkCandidateEntry[];
  readonly deleted: readonly string[];
  readonly baseTree?: BaseTreeAnchor;
  readonly baseTreeBundle?: BenchmarkBaseTreeBundle;
}

export interface BenchmarkOutputArtifact {
  readonly name: string;
  readonly digest: Digest;
  readonly byteLength: number;
  readonly mediaType?: string | null;
}

export interface BenchmarkRequest {
  readonly version: 1;
  readonly kind: 'benchmark_request';
  readonly storeId: string;
  readonly runId: string;
  readonly lockHash: Digest;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly dispatchGeneration: number;
  readonly requestDigest: string;
  readonly gateId: string;
  readonly checkId: string;
  readonly candidateDigest: string;
  readonly subject: Subject;
  readonly targetCellId: string;
  readonly targetHardware: HardwareTargetSpec;
  readonly stageAAudit?: StageAStaticAuditSpec;
  readonly heldOutWorkloadId: string;
  readonly metricThresholds: readonly MetricThresholdRule[];
  readonly maxPreemptions: number;
  readonly candidateArtifacts: BenchmarkCandidateArtifacts;
}

export type BenchmarkVerdictStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface BenchmarkVerdict {
  readonly version: 1;
  readonly kind: 'benchmark_verdict';
  readonly storeId: string;
  readonly runId: string;
  readonly lockHash: Digest;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly dispatchGeneration: number;
  readonly gateId: string;
  readonly checkId: string;
  readonly candidateDigest: string;
  readonly status: BenchmarkVerdictStatus;
  readonly reason: string | null;
  readonly expiresAtMs: string;
  readonly preemptionCount: number;
  readonly retryablePreemption?: boolean;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
  readonly hardwareProvenance?: HardwareProvenance;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
  readonly outputArtifacts?: readonly BenchmarkOutputArtifact[];
}

export interface SignedBenchmarkVerdictReceipt extends BenchmarkVerdict {
  readonly signature: string;
}

export interface WorkerJobPayload {
  readonly operationId: string;
  readonly gateId: string;
  readonly checkId: string;
  readonly candidateDigest: string;
  readonly subject: Subject;
  readonly targetCellId: string;
  readonly targetHardware: HardwareTargetSpec;
  readonly stageAAudit?: StageAStaticAuditSpec;
  readonly heldOutWorkloadId: string;
  readonly metricThresholds: readonly MetricThresholdRule[];
  readonly maxPreemptions: number;
  readonly preemptionCount: number;
  readonly candidateArtifacts: BenchmarkCandidateArtifacts;
}

export type RelayJobState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'preempted'
  | 'completed'
  | 'preempted_exhausted'
  | 'cancelled';

export interface LeaseState {
  readonly relayBootId: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly grantedMonotonicMs: number;
  readonly notAfterMonotonicMs: number;
  readonly createdWallMs: number;
  readonly createdMonotonicMs: number;
  readonly lastWallMs: number;
  readonly lastMonotonicMs: number;
  readonly cancelRequested: boolean;
}

export interface LeaseGrant {
  readonly relayBootId: string;
  readonly jobId: string;
  readonly operationId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly leaseTtlMs: number;
  readonly job: WorkerJobPayload;
}

export interface LeaseCredentials {
  readonly relayBootId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
}

export interface AcquireLeaseInput {
  readonly workerId: string;
  readonly capabilities: WorkerCapabilities;
  readonly waitMs?: number;
}

export interface HeartbeatLeaseInput extends LeaseCredentials {
  readonly state?: 'running';
}

export interface HeartbeatResponse {
  readonly desiredState: 'running' | 'cancel';
  readonly leaseTtlMs: number;
}

export interface PreemptLeaseInput extends LeaseCredentials {
  readonly reason?: string;
}

export interface PreemptResponse {
  readonly status: 'requeued' | 'preempted_exhausted';
  readonly preemptionCount: number;
}

export interface CompleteLeaseInput extends LeaseCredentials {
  readonly status: 'approved' | 'denied';
  readonly reason: string | null;
  readonly detail?: string | null;
  readonly metrics?: MetricsMap;
  readonly findings?: readonly StructuredFinding[];
  readonly hardwareProvenance?: HardwareProvenance;
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
  readonly outputArtifacts?: readonly BenchmarkOutputArtifact[];
}

export interface RelayJobSnapshot {
  readonly jobId: string;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly requestDigest: string;
  readonly state: RelayJobState;
  readonly preemptionCount: number;
  readonly maxPreemptions: number;
  readonly currentLeaseEpoch: number;
  readonly activeLease: Omit<LeaseState, 'leaseToken'> | null;
  readonly request: BenchmarkRequest;
  readonly verdict: BenchmarkVerdict;
}

export interface RelayServerHandle {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly relayBootId: string;
  readonly casDir: string;
  retainedTerminalCount(): number;
  close(): Promise<void>;
}
