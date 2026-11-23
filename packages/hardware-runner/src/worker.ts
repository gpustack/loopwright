import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { LIMITS, OVERLAY_LIMITS, SecretScrubber, type StructuredFinding } from '@loopwright/core';
import { readBoundedRegularFile } from '@loopwright/taskpack';
import {
  assertNoSymlinkAncestors,
  canonicalJson,
  expectNullProtoRecord,
  parseStrictJsonBytes,
} from './config.js';
import {
  evaluateBenchmarkJob,
  isRunnerTeardownError,
  RunnerTeardownError,
  type BenchmarkJobEvaluator,
  type EvaluatedBenchmarkJob,
} from './evaluator.js';
import {
  probeAcceleratorHealth,
  type CollectHardwareProvenanceOptions,
  type ProbeAcceleratorHealthOptions,
} from './provenance.js';
import {
  EMPTY_SHA256_HEX,
  MAX_CAS_CHUNK_BYTES,
  MAX_CONTROL_BODY_BYTES,
  parseBenchmarkRequest,
} from './relay-server.js';
import {
  HardwareRunnerError,
  type AcceleratorHealthProbeResult,
  type CompleteLeaseInput,
  type HardwareRunnerErrorCode,
  type HeartbeatResponse,
  type LeaseCredentials,
  type LeaseGrant,
  type PreemptResponse,
  type WorkerConfig,
  type WorkerJobPayload,
} from './types.js';

export interface WorkerMonotonicClock {
  nowMonotonicMs(): number;
}

export interface WorkerJobSettlementSummary {
  readonly jobId: string;
  readonly operationId: string;
  readonly leaseEpoch: number;
  readonly outcome: 'completed' | 'preempted' | 'cancelled' | 'fenced' | 'unknown';
  readonly acknowledgment: 'confirmed' | 'fenced' | 'unknown' | 'local_only';
  readonly status?: 'approved' | 'denied';
  readonly preemptionStatus?: 'requeued' | 'preempted_exhausted';
  readonly preemptionCount?: number;
  readonly relayErrorCode?: HardwareRunnerErrorCode;
}

export interface RunHardwareWorkerOptions {
  readonly config: WorkerConfig;
  readonly once?: boolean;
  readonly signal?: AbortSignal;
  readonly preemptSignal?: AbortSignal;
  readonly registerProcessSignalHandlers?: boolean;
  readonly enableSseEvents?: boolean;
  readonly idleRetryDelayMs?: number;
  readonly clock?: WorkerMonotonicClock;
  readonly evaluator?: BenchmarkJobEvaluator;
  readonly probe?: (options: CollectHardwareProvenanceOptions) => ReturnType<typeof import('./provenance.js').collectHardwareProvenance>;
  readonly healthProbe?: (options: ProbeAcceleratorHealthOptions) => Promise<AcceleratorHealthProbeResult>;
  readonly onLeaseAcquired?: (grant: LeaseGrant) => void | Promise<void>;
  readonly onJobSettled?: (summary: WorkerJobSettlementSummary) => void | Promise<void>;
}

export interface RunHardwareWorkerResult {
  readonly polls: number;
  readonly jobsProcessed: number;
  readonly lastSettlement: WorkerJobSettlementSummary | null;
  readonly exitReason: 'once_idle' | 'once_completed' | 'aborted' | 'preempted';
}

export const MAX_LEASE_TTL_MS = 600_000;

export class RunnerTransportError extends HardwareRunnerError {
  readonly transientTransport = true as const;
  readonly reasonCode = 'RUNNER_TRANSPORT_ERROR' as const;
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number, options?: ErrorOptions) {
    super('RUNNER_SANDBOX_FAILED', message, undefined, options);
    this.name = 'RunnerTransportError';
    if (httpStatus !== undefined) {
      this.httpStatus = httpStatus;
    }
  }
}

export function isRunnerTransportError(err: unknown): boolean {
  return (
    err instanceof RunnerTransportError
    || (err instanceof Error && (err as { readonly transientTransport?: unknown }).transientTransport === true)
  );
}

function tagRequestSent<T extends Error>(err: T, sent: boolean): T {
  Object.defineProperty(err, 'requestSent', {
    value: sent,
    enumerable: false,
    configurable: true,
  });
  return err;
}

function wasRequestSent(err: unknown): boolean {
  if (err !== null && typeof err === 'object' && 'requestSent' in err) {
    return (err as { readonly requestSent?: unknown }).requestSent === true;
  }
  return true;
}

const GRANT_KEYS: ReadonlySet<string> = new Set([
  'relayBootId',
  'jobId',
  'operationId',
  'leaseEpoch',
  'leaseToken',
  'leaseTtlMs',
  'job',
]);
const HEARTBEAT_RESPONSE_KEYS: ReadonlySet<string> = new Set(['desiredState', 'leaseTtlMs', 'leaseEpoch']);
const PREEMPT_RESPONSE_KEYS: ReadonlySet<string> = new Set(['status', 'preemptionCount']);
const COMPLETE_RESPONSE_KEYS: ReadonlySet<string> = new Set(['ok', 'operationId', 'status']);
const BLOB_PUT_RESPONSE_KEYS: ReadonlySet<string> = new Set(['ok', 'sha256', 'byteLength']);
const VALID_ERROR_CODES: ReadonlySet<HardwareRunnerErrorCode> = new Set([
  'CONFIG_INVALID',
  'QUEUE_LEASE_FENCED',
  'QUEUE_STATE_INVALID',
  'QUEUE_CAPACITY_EXCEEDED',
  'QUEUE_JOB_CONFLICT',
  'ARTIFACT_INVALID',
  'ARTIFACT_MISSING',
  'AUTH_UNAUTHORIZED',
  'AUTH_FORBIDDEN',
  'PAYLOAD_TOO_LARGE',
  'NOT_FOUND',
  'RUNNER_SANDBOX_FAILED',
  'WORKER_DEVICE_QUARANTINED',
]);
const DETERMINISTIC_EVAL_ERROR_CODES: ReadonlySet<HardwareRunnerErrorCode> = new Set([
  'ARTIFACT_INVALID',
  'PAYLOAD_TOO_LARGE',
]);
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PRE_SEND_SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
]);

function isPreSendSocketErrorCode(code: unknown): boolean {
  if (typeof code !== 'string' || code.length === 0) return false;
  return (
    PRE_SEND_SOCKET_ERROR_CODES.has(code)
    || code.startsWith('ERR_TLS_')
    || code.startsWith('CERT_')
    || code.startsWith('UNABLE_TO_VERIFY_')
  );
}

const DEFAULT_WORKER_CLOCK: WorkerMonotonicClock = {
  nowMonotonicMs: () => performance.now(),
};

interface OutboundHttpClient {
  requestJson(options: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly status: number; readonly bytes: Buffer }>;
  downloadBlobToStream(options: {
    readonly jobId: string;
    readonly creds: LeaseCredentials;
    readonly sha256: string;
    readonly expectedByteLength: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onChunk: (chunk: Uint8Array) => Promise<void>;
  }): Promise<void>;
  uploadBlobFromFile(options: {
    readonly jobId: string;
    readonly creds: LeaseCredentials;
    readonly filePath: string;
    readonly sha256: string;
    readonly expectedByteLength: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  watchCancelEvents(options: {
    readonly jobId: string;
    readonly creds: LeaseCredentials;
    readonly signal: AbortSignal;
    readonly onCancel: () => void;
    readonly onFenced: () => void;
    readonly onDisconnected?: () => void;
  }): Promise<void>;
  close(): void;
}

function parseErrorCodeFromJson(bytes: Buffer): HardwareRunnerErrorCode | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CONTROL_BODY_BYTES) return null;
  try {
    const parsed = parseStrictJsonBytes(bytes, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/error');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      if (Object.hasOwn(rec, 'code') && typeof rec.code === 'string' && VALID_ERROR_CODES.has(rec.code as HardwareRunnerErrorCode)) {
        return rec.code as HardwareRunnerErrorCode;
      }
    }
  } catch {
    // Ignore malformed error body.
  }
  return null;
}

function mapHttpError(status: number, bytes: Buffer, fallbackMessage: string): HardwareRunnerError {
  const remoteCode = parseErrorCodeFromJson(bytes);
  if (status === 401) {
    return new HardwareRunnerError('AUTH_UNAUTHORIZED', fallbackMessage);
  }
  if (status === 403) {
    return new HardwareRunnerError('AUTH_FORBIDDEN', fallbackMessage);
  }
  if (status === 404) {
    return new HardwareRunnerError('NOT_FOUND', fallbackMessage);
  }
  if (status === 409) {
    const code: HardwareRunnerErrorCode = remoteCode ?? 'QUEUE_STATE_INVALID';
    return new HardwareRunnerError(code, fallbackMessage);
  }
  if (status === 413) {
    return new HardwareRunnerError('PAYLOAD_TOO_LARGE', fallbackMessage);
  }
  if (status === 429) {
    return new HardwareRunnerError('QUEUE_CAPACITY_EXCEEDED', fallbackMessage);
  }
  if (remoteCode !== null && status >= 400 && status < 500) {
    return new HardwareRunnerError(remoteCode, `${fallbackMessage} (HTTP ${status})`);
  }
  if (status === 408 || status >= 500 || status === 0) {
    return new RunnerTransportError(`${fallbackMessage} (HTTP ${status})`, status);
  }
  return new HardwareRunnerError('ARTIFACT_INVALID', `${fallbackMessage} (HTTP ${status})`);
}

function computeConservativeLeaseMarginMs(leaseTtlMs: number): number {
  return Math.min(1_000, Math.max(5, Math.floor(leaseTtlMs * 0.2)));
}

function validateHeartbeatResponsePayload(
  bytes: Buffer,
  expectedEpoch: number,
): HeartbeatResponse {
  const raw = parseStrictJsonBytes(bytes, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/heartbeat');
  const rec = expectNullProtoRecord(
    raw,
    HEARTBEAT_RESPONSE_KEYS,
    ['desiredState', 'leaseTtlMs'],
    'ARTIFACT_INVALID',
    '/heartbeat',
  );
  if (rec.desiredState !== 'running' && rec.desiredState !== 'cancel') {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid heartbeat desiredState', '/heartbeat/desiredState');
  }
  if (
    typeof rec.leaseTtlMs !== 'number'
    || !Number.isSafeInteger(rec.leaseTtlMs)
    || Object.is(rec.leaseTtlMs, -0)
    || rec.leaseTtlMs < 10
    || rec.leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid heartbeat leaseTtlMs', '/heartbeat/leaseTtlMs');
  }
  if (Object.hasOwn(rec, 'leaseEpoch') && rec.leaseEpoch !== expectedEpoch) {
    throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'heartbeat response leaseEpoch mismatch', '/heartbeat/leaseEpoch');
  }
  return Object.freeze({
    desiredState: rec.desiredState,
    leaseTtlMs: rec.leaseTtlMs,
  });
}

function validatePreemptResponsePayload(bytes: Buffer, grantedJob: WorkerJobPayload): PreemptResponse {
  const raw = parseStrictJsonBytes(bytes, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/preempt');
  const rec = expectNullProtoRecord(
    raw,
    PREEMPT_RESPONSE_KEYS,
    ['status', 'preemptionCount'],
    'ARTIFACT_INVALID',
    '/preempt',
  );
  if (rec.status !== 'requeued' && rec.status !== 'preempted_exhausted') {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid preempt status', '/preempt/status');
  }
  if (
    typeof rec.preemptionCount !== 'number'
    || !Number.isSafeInteger(rec.preemptionCount)
    || Object.is(rec.preemptionCount, -0)
    || rec.preemptionCount < grantedJob.preemptionCount
    || rec.preemptionCount > grantedJob.maxPreemptions
    || rec.preemptionCount > 16
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid preempt preemptionCount', '/preempt/preemptionCount');
  }
  if (grantedJob.preemptionCount + 1 <= grantedJob.maxPreemptions) {
    if (rec.status !== 'requeued' || rec.preemptionCount !== grantedJob.preemptionCount + 1) {
      throw new HardwareRunnerError(
        'ARTIFACT_INVALID',
        'preempt receipt inconsistent with remaining preemption budget',
        '/preempt',
      );
    }
  } else if (rec.status !== 'preempted_exhausted' || rec.preemptionCount !== grantedJob.preemptionCount) {
    throw new HardwareRunnerError(
      'ARTIFACT_INVALID',
      'impossible requeue receipt when preemption budget is exhausted',
      '/preempt',
    );
  }
  return Object.freeze({
    status: rec.status,
    preemptionCount: rec.preemptionCount,
  });
}

function validateBlobUploadResponsePayload(
  bytes: Buffer,
  expectedSha256: string,
  expectedByteLength: number,
): void {
  if (bytes.byteLength === 0) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'empty Stage A blob upload receipt from Relay', '/blobPut');
  }
  const raw = parseStrictJsonBytes(bytes, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/blobPut');
  const rec = expectNullProtoRecord(
    raw,
    BLOB_PUT_RESPONSE_KEYS,
    ['ok', 'sha256', 'byteLength'],
    'ARTIFACT_INVALID',
    '/blobPut',
  );
  if (
    rec.ok !== true
    || rec.sha256 !== expectedSha256
    || typeof rec.byteLength !== 'number'
    || !Number.isSafeInteger(rec.byteLength)
    || Object.is(rec.byteLength, -0)
    || rec.byteLength !== expectedByteLength
  ) {
    throw new HardwareRunnerError(
      'ARTIFACT_INVALID',
      'Stage A blob upload receipt mismatched expected ok/sha256/byteLength',
      '/blobPut',
    );
  }
}

function validateCompleteResponsePayload(
  bytes: Buffer,
  expectedOperationId: string,
  expectedStatus: 'approved' | 'denied',
): void {
  const raw = parseStrictJsonBytes(bytes, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/complete');
  const rec = expectNullProtoRecord(
    raw,
    COMPLETE_RESPONSE_KEYS,
    ['ok', 'operationId', 'status'],
    'ARTIFACT_INVALID',
    '/complete',
  );
  if (rec.ok !== true || rec.operationId !== expectedOperationId || rec.status !== expectedStatus) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'malformed lease completion acknowledgment from Relay', '/complete');
  }
}

function parseLeaseGrantPayload(bytes: Buffer, maxBlobBytes: number): LeaseGrant {
  const raw = parseStrictJsonBytes(bytes, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/grant');
  const root = expectNullProtoRecord(
    raw,
    GRANT_KEYS,
    ['relayBootId', 'jobId', 'operationId', 'leaseEpoch', 'leaseToken', 'leaseTtlMs', 'job'],
    'ARTIFACT_INVALID',
    '/grant',
  );
  if (
    typeof root.relayBootId !== 'string'
    || root.relayBootId.length === 0
    || typeof root.jobId !== 'string'
    || root.jobId.length === 0
    || typeof root.operationId !== 'string'
    || root.operationId.length === 0
    || typeof root.leaseToken !== 'string'
    || root.leaseToken.length === 0
    || typeof root.leaseEpoch !== 'number'
    || !Number.isSafeInteger(root.leaseEpoch)
    || root.leaseEpoch < 1
    || typeof root.leaseTtlMs !== 'number'
    || !Number.isSafeInteger(root.leaseTtlMs)
    || Object.is(root.leaseTtlMs, -0)
    || root.leaseTtlMs < 10
    || root.leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'malformed LeaseGrant fields from Relay', '/grant');
  }

  if (root.job === null || typeof root.job !== 'object' || Array.isArray(root.job)) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'malformed LeaseGrant.job object', '/grant/job');
  }
  const jobObj = root.job as Record<string, unknown>;
  const subjectObj = (jobObj.subject !== null && typeof jobObj.subject === 'object' && !Array.isArray(jobObj.subject))
    ? (jobObj.subject as Record<string, unknown>)
    : null;
  if (subjectObj === null) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'missing LeaseGrant.job.subject', '/grant/job/subject');
  }

  const validatedReq = parseBenchmarkRequest(
    {
      version: 1,
      kind: 'benchmark_request',
      storeId: 'worker-grant',
      runId: 'worker-grant',
      lockHash: subjectObj.lockHash,
      operationId: jobObj.operationId,
      dispatchId: 'worker-grant',
      dispatchGeneration: 0,
      requestDigest: '0'.repeat(64),
      gateId: jobObj.gateId,
      checkId: jobObj.checkId,
      candidateDigest: jobObj.candidateDigest,
      subject: jobObj.subject,
      targetCellId: jobObj.targetCellId,
      targetHardware: jobObj.targetHardware,
      ...(Object.hasOwn(jobObj, 'stageAAudit') ? { stageAAudit: jobObj.stageAAudit } : {}),
      heldOutWorkloadId: jobObj.heldOutWorkloadId,
      ...(Object.hasOwn(jobObj, 'metricThresholds') ? { metricThresholds: jobObj.metricThresholds } : {}),
      ...(Object.hasOwn(jobObj, 'maxPreemptions') ? { maxPreemptions: jobObj.maxPreemptions } : {}),
      candidateArtifacts: jobObj.candidateArtifacts,
    },
    maxBlobBytes,
  );
  const preemptionCount = typeof jobObj.preemptionCount === 'number'
    && Number.isSafeInteger(jobObj.preemptionCount)
    && jobObj.preemptionCount >= 0
    && jobObj.preemptionCount <= 16
    ? jobObj.preemptionCount
    : -1;
  if (preemptionCount < 0 || preemptionCount > validatedReq.maxPreemptions || validatedReq.operationId !== root.operationId) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid LeaseGrant.job preemptionCount or operationId', '/grant/job');
  }

  const jobPayload: WorkerJobPayload = Object.freeze({
    operationId: validatedReq.operationId,
    gateId: validatedReq.gateId,
    checkId: validatedReq.checkId,
    candidateDigest: validatedReq.candidateDigest,
    subject: validatedReq.subject,
    targetCellId: validatedReq.targetCellId,
    targetHardware: validatedReq.targetHardware,
    ...(validatedReq.stageAAudit !== undefined ? { stageAAudit: validatedReq.stageAAudit } : {}),
    heldOutWorkloadId: validatedReq.heldOutWorkloadId,
    metricThresholds: validatedReq.metricThresholds,
    maxPreemptions: validatedReq.maxPreemptions,
    preemptionCount,
    candidateArtifacts: validatedReq.candidateArtifacts,
  });

  return Object.freeze({
    relayBootId: root.relayBootId,
    jobId: root.jobId,
    operationId: root.operationId,
    leaseEpoch: root.leaseEpoch,
    leaseToken: root.leaseToken,
    leaseTtlMs: root.leaseTtlMs,
    job: jobPayload,
  });
}

async function createOutboundHttpClient(config: WorkerConfig): Promise<OutboundHttpClient> {
  const baseUrl = new URL(config.relayUrl);
  const isHttps = baseUrl.protocol === 'https:';
  let httpsAgent: HttpsAgent | undefined;
  let caPem: Buffer | undefined;

  if (isHttps) {
    if (config.tlsCaPath !== undefined) {
      await assertNoSymlinkAncestors(config.tlsCaPath, {
        checkLeaf: true,
        code: 'CONFIG_INVALID',
        diagPath: '/tlsCaPath',
      });
      const rawCa = await readBoundedRegularFile(config.tlsCaPath, 262_144, msg => {
        throw new HardwareRunnerError('CONFIG_INVALID', msg, '/tlsCaPath');
      });
      caPem = Buffer.from(rawCa);
    }
    httpsAgent = new HttpsAgent({
      keepAlive: true,
      rejectUnauthorized: true,
      ...(caPem !== undefined ? { ca: caPem } : {}),
    });
  }

  const basePathname = baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/+$/, '');
  const cleanHost = baseUrl.hostname.replace(/^\[|\]$/g, '');
  const buildRequestOptions = (
    method: string,
    subpath: string,
    headers: Readonly<Record<string, string>>,
  ): HttpsRequestOptions => ({
    protocol: baseUrl.protocol,
    hostname: cleanHost,
    ...(baseUrl.port !== '' ? { port: Number(baseUrl.port) } : {}),
    path: `${basePathname}${subpath}`,
    method,
    headers: {
      authorization: `Bearer ${config.workerToken}`,
      ...headers,
    },
    ...(isHttps
      ? {
          agent: httpsAgent,
          rejectUnauthorized: true,
          ...(caPem !== undefined ? { ca: caPem } : {}),
        }
      : {}),
  });

  const sendFn = (opts: HttpsRequestOptions, cb: (res: IncomingMessage) => void) =>
    isHttps ? httpsRequest(opts, cb) : httpRequest(opts as RequestOptions, cb);

  return {
    requestJson({ method, path, headers = {}, body, timeoutMs, signal }): Promise<{ readonly status: number; readonly bytes: Buffer }> {
      if (signal?.aborted) {
        return Promise.reject(
          tagRequestSent(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'request aborted'), false),
        );
      }
      let payloadBytes: Buffer | null = null;
      if (body !== undefined) {
        let serialized: string;
        try {
          serialized = canonicalJson(body);
        } catch (serErr: unknown) {
          const wrapped = serErr instanceof Error
            ? serErr
            : new HardwareRunnerError('ARTIFACT_INVALID', 'failed to serialize control request');
          return Promise.reject(tagRequestSent(wrapped, false));
        }
        payloadBytes = Buffer.from(serialized, 'utf8');
        if (payloadBytes.byteLength > MAX_CONTROL_BODY_BYTES) {
          return Promise.reject(
            tagRequestSent(
              new HardwareRunnerError('PAYLOAD_TOO_LARGE', `worker control request exceeded ${MAX_CONTROL_BODY_BYTES} bytes`),
              false,
            ),
          );
        }
      }
      const effectiveHeaders: Record<string, string> = {
        ...headers,
        ...(payloadBytes !== null
          ? {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(payloadBytes.byteLength),
            }
          : {}),
      };

      return new Promise((resolveReq, rejectReq) => {
        let settled = false;
        let socketConnected = false;
        let writeDispatched = false;
        let responseReceived = false;

        const computeRequestSent = (overrideSent?: boolean): boolean => {
          if (overrideSent !== undefined) return overrideSent;
          return responseReceived || (socketConnected && writeDispatched);
        };

        const finishErr = (err: Error, overrideSent?: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          rejectReq(tagRequestSent(err, computeRequestSent(overrideSent)));
        };

        const req = sendFn(buildRequestOptions(method, path, effectiveHeaders), (res: IncomingMessage) => {
          responseReceived = true;
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            finishErr(new HardwareRunnerError('AUTH_FORBIDDEN', 'HTTP redirects from Relay are forbidden'), true);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (rawChunk: Buffer | Uint8Array) => {
            const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
            total += buf.byteLength;
            if (total > MAX_CONTROL_BODY_BYTES) {
              req.destroy();
              finishErr(new HardwareRunnerError('PAYLOAD_TOO_LARGE', 'Relay control response exceeded 64 KiB'), true);
              return;
            }
            chunks.push(buf);
          });
          res.on('error', err => finishErr(err, true));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolveReq({
              status,
              bytes: chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total),
            });
          });
        });

        req.on('socket', socket => {
          if (isHttps) {
            const tlsSock = socket as TLSSocket;
            if (!tlsSock.connecting && !(tlsSock as { secureConnecting?: boolean }).secureConnecting && tlsSock.authorized) {
              socketConnected = true;
            } else {
              tlsSock.once('secureConnect', () => {
                if (tlsSock.authorized) {
                  socketConnected = true;
                }
              });
            }
          } else if (!socket.connecting) {
            socketConnected = true;
          } else {
            socket.once('connect', () => {
              socketConnected = true;
            });
          }
        });

        const onAbort = () => {
          const sentBeforeAbort = computeRequestSent();
          req.destroy();
          finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'worker HTTP request aborted'), sentBeforeAbort);
        };
        const timer = setTimeout(() => {
          const sentBeforeTimeout = computeRequestSent();
          req.destroy();
          finishErr(new RunnerTransportError('worker HTTP request timed out'), sentBeforeTimeout);
        }, timeoutMs);
        timer.unref();
        signal?.addEventListener('abort', onAbort, { once: true });
        req.on('error', err => {
          const errnoCode = (err as NodeJS.ErrnoException)?.code;
          const sent = responseReceived || (socketConnected && writeDispatched && !isPreSendSocketErrorCode(errnoCode));
          finishErr(new RunnerTransportError(`worker HTTP transport error: ${err.message}`, undefined, { cause: err }), sent);
        });
        if (payloadBytes !== null) {
          req.end(payloadBytes);
        } else {
          req.end();
        }
        writeDispatched = true;
      });
    },

    downloadBlobToStream({ jobId, creds, sha256, expectedByteLength, timeoutMs, signal, onChunk }): Promise<void> {
      if (!SHA256_HEX_RE.test(sha256)) {
        return Promise.reject(new HardwareRunnerError('ARTIFACT_INVALID', 'invalid blob sha256 digest'));
      }
      if ((expectedByteLength === 0) !== (sha256 === EMPTY_SHA256_HEX)) {
        return Promise.reject(new HardwareRunnerError('ARTIFACT_INVALID', 'empty blob digest mismatch'));
      }
      if (signal?.aborted) {
        return Promise.reject(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'blob download aborted'));
      }

      const path = `/v1/runner/leases/${encodeURIComponent(jobId)}/blobs/${sha256}`;
      const headers: Record<string, string> = {
        'x-loopwright-relay-boot-id': creds.relayBootId,
        'x-loopwright-lease-epoch': String(creds.leaseEpoch),
        'x-loopwright-lease-token': creds.leaseToken,
      };

      return new Promise<void>((resolveDl, rejectDl) => {
        let settled = false;
        const finishErr = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          const normalizedErr = err instanceof HardwareRunnerError
            ? err
            : new RunnerTransportError(`blob download transport error: ${err.message}`);
          rejectDl(normalizedErr);
        };
        const req = sendFn(buildRequestOptions('GET', path, headers), (res: IncomingMessage) => {
          void (async () => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              throw new HardwareRunnerError('AUTH_FORBIDDEN', 'HTTP redirects on blob download are forbidden');
            }
            if (status !== 200) {
              const errChunks: Buffer[] = [];
              let errLen = 0;
              for await (const c of res) {
                const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
                errLen += b.byteLength;
                if (errLen > MAX_CONTROL_BODY_BYTES) {
                  res.destroy();
                  req.destroy();
                  throw new RunnerTransportError('Relay blob error response exceeded 64 KiB', status);
                }
                errChunks.push(b);
              }
              const errBytes = Buffer.concat(errChunks, errLen);
              if (status === 401) {
                throw new HardwareRunnerError('AUTH_UNAUTHORIZED', `unauthorized blob download ${sha256}`);
              }
              if (status === 403) {
                throw new HardwareRunnerError('AUTH_FORBIDDEN', `forbidden blob download ${sha256}`);
              }
              if (status === 409 && parseErrorCodeFromJson(errBytes) === 'QUEUE_LEASE_FENCED') {
                throw new HardwareRunnerError('QUEUE_LEASE_FENCED', `lease fenced during blob download ${sha256}`);
              }
              // Distinguish Relay/transport HTTP failures (e.g. 503/5xx/429/404) from verified candidate content errors!
              throw new RunnerTransportError(
                `failed to download input blob ${sha256} from Relay (HTTP ${status})`,
                status,
              );
            }

            const headerSha = res.headers['x-loopwright-blob-sha256'];
            const headerLen = res.headers['x-loopwright-blob-length'];
            if (
              typeof headerSha !== 'string'
              || !SHA256_HEX_RE.test(headerSha)
              || headerSha !== sha256
              || typeof headerLen !== 'string'
              || headerLen !== String(expectedByteLength)
            ) {
              res.destroy();
              throw new RunnerTransportError(
                'Relay blob response headers missing or mismatched expected digest/length',
                status,
              );
            }

            const hasher = createHash('sha256');
            let received = 0;
            for await (const rawChunk of res) {
              if (signal?.aborted) {
                res.destroy();
                throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'blob download aborted');
              }
              const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
              for (let off = 0; off < buf.byteLength; off += MAX_CAS_CHUNK_BYTES) {
                const slice = buf.subarray(off, Math.min(buf.byteLength, off + MAX_CAS_CHUNK_BYTES));
                received += slice.byteLength;
                if (received > expectedByteLength) {
                  res.destroy();
                  throw new HardwareRunnerError('ARTIFACT_INVALID', 'downloaded blob exceeded expectedByteLength');
                }
                hasher.update(slice);
                await onChunk(slice);
              }
            }
            if (!res.complete) {
              throw new RunnerTransportError(
                'Relay blob download stream truncated before HTTP response completion',
                status,
              );
            }
            if (received !== expectedByteLength || hasher.digest('hex') !== sha256) {
              throw new HardwareRunnerError('ARTIFACT_INVALID', 'downloaded blob failed sha256 or byteLength verification');
            }
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              resolveDl();
            }
          })().catch(err => finishErr(err instanceof Error ? err : new Error(String(err))));
        });
        const onAbort = () => {
          req.destroy();
          finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'blob download aborted'));
        };
        const timer = setTimeout(() => {
          req.destroy();
          finishErr(new RunnerTransportError('blob download timed out'));
        }, timeoutMs);
        timer.unref();
        signal?.addEventListener('abort', onAbort, { once: true });
        req.on('error', err => finishErr(new RunnerTransportError(`blob download socket error: ${err.message}`)));
        req.end();
      });
    },

    async uploadBlobFromFile({ jobId, creds, filePath, sha256, expectedByteLength, timeoutMs, signal }): Promise<void> {
      const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
      await assertNoSymlinkAncestors(filePath, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/outputBlob' });
      const handle = await open(filePath, constants.O_RDONLY | noFollow);
      let readerTask: Promise<void> = Promise.resolve();
      try {
        const st = await handle.stat();
        if (
          !st.isFile()
          || st.isSymbolicLink()
          || st.nlink !== 1
          || (st.mode & 0o7777) !== 0o400
          || st.size !== expectedByteLength
        ) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'sealed Stage A blob violated 0o400/nlink/size invariant before upload');
        }

        const path = `/v1/runner/leases/${encodeURIComponent(jobId)}/blobs/${sha256}`;
        const headers: Record<string, string> = {
          'content-type': 'application/octet-stream',
          'content-length': String(expectedByteLength),
          'x-loopwright-relay-boot-id': creds.relayBootId,
          'x-loopwright-lease-epoch': String(creds.leaseEpoch),
          'x-loopwright-lease-token': creds.leaseToken,
          'x-loopwright-blob-sha256': sha256,
          'x-loopwright-blob-length': String(expectedByteLength),
        };

        await new Promise<void>((resolveUl, rejectUl) => {
          let settled = false;
          let localVerified = false;
          let remoteAcked = false;

          const finishErr = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            rejectUl(err);
          };

          const maybeFinishOk = () => {
            if (!settled && localVerified && remoteAcked) {
              settled = true;
              clearTimeout(timer);
              signal?.removeEventListener('abort', onAbort);
              resolveUl();
            }
          };

          const req = sendFn(buildRequestOptions('PUT', path, headers), (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (c: Buffer | Uint8Array) => {
              const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
              total += b.byteLength;
              if (total > MAX_CONTROL_BODY_BYTES) {
                req.destroy();
                finishErr(new HardwareRunnerError('PAYLOAD_TOO_LARGE', 'Relay blob upload response exceeded 64 KiB'));
                return;
              }
              chunks.push(b);
            });
            res.on('error', err => finishErr(err));
            res.on('end', () => {
              if (settled) return;
              const status = res.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                finishErr(new HardwareRunnerError('AUTH_FORBIDDEN', 'HTTP redirects on blob upload are forbidden'));
                return;
              }
              if (status !== 200 && status !== 201) {
                finishErr(mapHttpError(status, Buffer.concat(chunks, total), `Stage A blob upload failed for ${sha256}`));
                return;
              }
              try {
                validateBlobUploadResponsePayload(Buffer.concat(chunks, total), sha256, expectedByteLength);
              } catch (receiptErr: unknown) {
                finishErr(receiptErr instanceof Error ? receiptErr : new Error(String(receiptErr)));
                return;
              }
              remoteAcked = true;
              maybeFinishOk();
            });
          });

          const onAbort = () => {
            req.destroy();
            finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A blob upload aborted'));
          };
          const timer = setTimeout(() => {
            req.destroy();
            finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A blob upload timed out'));
          }, timeoutMs);
          timer.unref();
          signal?.addEventListener('abort', onAbort, { once: true });
          req.on('error', err => finishErr(err));

          readerTask = (async () => {
            const chunkBuf = Buffer.allocUnsafe(Math.min(MAX_CAS_CHUNK_BYTES, Math.max(1, expectedByteLength)));
            const hasher = createHash('sha256');
            let offset = 0;
            while (offset < expectedByteLength) {
              if (signal?.aborted) {
                req.destroy();
                finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A blob upload aborted'));
                return;
              }
              if (settled) return;
              const toRead = Math.min(chunkBuf.byteLength, expectedByteLength - offset);
              const { bytesRead } = await handle.read(chunkBuf, 0, toRead, offset);
              if (bytesRead <= 0) break;
              const slice = Buffer.from(chunkBuf.subarray(0, bytesRead));
              hasher.update(slice);
              offset += bytesRead;
              if (!req.destroyed && !req.writableEnded) {
                const canWrite = req.write(slice);
                if (!canWrite && !req.destroyed) {
                  await new Promise<void>(resolveDrain => {
                    const onDrain = () => {
                      req.removeListener('close', onClose);
                      resolveDrain();
                    };
                    const onClose = () => {
                      req.removeListener('drain', onDrain);
                      resolveDrain();
                    };
                    req.once('drain', onDrain);
                    req.once('close', onClose);
                  });
                }
              }
            }
            if (settled) return;
            if (signal?.aborted) {
              req.destroy();
              finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A blob upload aborted'));
              return;
            }
            if (offset !== expectedByteLength || hasher.digest('hex') !== sha256) {
              req.destroy();
              finishErr(new HardwareRunnerError('ARTIFACT_INVALID', 'sealed Stage A blob changed size or digest during upload'));
              return;
            }
            localVerified = true;
            if (!req.destroyed && !req.writableEnded) {
              req.end();
            } else if (!remoteAcked) {
              finishErr(new HardwareRunnerError('RUNNER_SANDBOX_FAILED', 'Stage A blob upload stream closed before acknowledgment'));
              return;
            }
            maybeFinishOk();
          })().catch(err => {
            req.destroy();
            finishErr(err instanceof Error ? err : new Error(String(err)));
          });
        });
      } finally {
        await readerTask.catch(() => {});
        await handle.close();
      }
    },

    watchCancelEvents({ jobId, creds, signal, onCancel, onFenced, onDisconnected }): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      const path = `/v1/runner/leases/${encodeURIComponent(jobId)}/events`;
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'x-loopwright-relay-boot-id': creds.relayBootId,
        'x-loopwright-lease-epoch': String(creds.leaseEpoch),
        'x-loopwright-lease-token': creds.leaseToken,
      };
      return new Promise<void>(resolveWatch => {
        let done = false;
        let sawExplicitEvent = false;
        const finish = (unexpectedDisconnect: boolean) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          if (unexpectedDisconnect && !signal.aborted && !sawExplicitEvent) {
            onDisconnected?.();
          }
          resolveWatch();
        };
        const req = sendFn(buildRequestOptions('GET', path, headers), (res: IncomingMessage) => {
          const status = res.statusCode ?? 0;
          if (status === 409) {
            sawExplicitEvent = true;
            res.resume();
            onFenced();
            finish(false);
            return;
          }
          if (status !== 200) {
            res.resume();
            finish(true);
            return;
          }
          let buffer = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
            if (buffer.length > 16_384) {
              req.destroy();
              finish(true);
              return;
            }
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = frame.split(/\r?\n/);
              for (const line of lines) {
                let isCancelEvent = line === 'event: cancel';
                if (!isCancelEvent && line.startsWith('data:')) {
                  const dataPayload = line.slice(5).trim();
                  try {
                    const parsed = JSON.parse(dataPayload) as unknown;
                    if (
                      parsed !== null
                      && typeof parsed === 'object'
                      && !Array.isArray(parsed)
                      && Object.hasOwn(parsed, 'desiredState')
                      && (parsed as Record<string, unknown>)['desiredState'] === 'cancel'
                    ) {
                      isCancelEvent = true;
                    }
                  } catch {
                    // Ignore malformed or non-JSON SSE data payloads.
                  }
                }
                if (isCancelEvent) {
                  sawExplicitEvent = true;
                  onCancel();
                  req.destroy();
                  finish(false);
                  return;
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          });
          res.on('end', () => finish(true));
          res.on('error', () => finish(true));
        });
        const onAbort = () => {
          req.destroy();
          finish(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('error', () => finish(true));
        req.end();
      });
    },

    close(): void {
      httpsAgent?.destroy();
    },
  };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>(resolveSleep => {
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    // Keep the timer ref'd: the outbound-only worker holds no listening sockets, so unref'ing
    // the retry/idle timer would let Node's event loop drain prematurely instead of retrying.
    // Shutdown/preemption still exits immediately because onAbort clears the timer.
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run the outbound-only pull-lease GPU/NPU worker loop (zero inbound listening ports).
 */
export async function runHardwareWorker(options: RunHardwareWorkerOptions): Promise<RunHardwareWorkerResult> {
  const { config } = options;
  if (config.sandboxBackend === 'native_os' && config.probeMode === 'physical') {
    throw new HardwareRunnerError(
      'RUNNER_SANDBOX_FAILED',
      'native_os sandbox backend cannot enforce isolated physical accelerator device allocation; docker backend is required',
    );
  }

  await assertNoSymlinkAncestors(resolve(config.workDir), {
    checkLeaf: true,
    code: 'CONFIG_INVALID',
    diagPath: '/workDir',
  });
  await assertNoSymlinkAncestors(resolve(config.heldOutWorkloadsDir), {
    checkLeaf: true,
    code: 'CONFIG_INVALID',
    diagPath: '/heldOutWorkloadsDir',
  });

  const clock = options.clock ?? DEFAULT_WORKER_CLOCK;
  const processShutdown = new AbortController();
  const processPreempt = new AbortController();
  const onSigTerm = () => processPreempt.abort();
  const onSigInt = () => processShutdown.abort();
  if (options.registerProcessSignalHandlers !== false) {
    process.once('SIGTERM', onSigTerm);
    process.once('SIGINT', onSigInt);
  }

  const stopSignals: AbortSignal[] = [processShutdown.signal];
  if (options.signal !== undefined) stopSignals.push(options.signal);
  const shutdownSignal = AbortSignal.any(stopSignals);

  const preemptSignals: AbortSignal[] = [processPreempt.signal];
  if (options.preemptSignal !== undefined) preemptSignals.push(options.preemptSignal);
  const preemptSignal = AbortSignal.any(preemptSignals);

  const client = await createOutboundHttpClient(config);
  const evaluator: BenchmarkJobEvaluator = options.evaluator ?? evaluateBenchmarkJob;
  const healthProbeRunner = options.healthProbe ?? probeAcceleratorHealth;
  let polls = 0;
  let jobsProcessed = 0;
  let lastSettlement: WorkerJobSettlementSummary | null = null;
  let quarantineError: HardwareRunnerError | null = null;

  try {
    while (true) {
      if (quarantineError !== null) {
        throw quarantineError;
      }
      if (preemptSignal.aborted) {
        return { polls, jobsProcessed, lastSettlement, exitReason: 'preempted' };
      }
      if (shutdownSignal.aborted) {
        return { polls, jobsProcessed, lastSettlement, exitReason: 'aborted' };
      }

      polls += 1;
      const acquireSignal = AbortSignal.any([shutdownSignal, preemptSignal]);
      const acquireSentMono = clock.nowMonotonicMs();
      let acquireRes: { readonly status: number; readonly bytes: Buffer };
      try {
        acquireRes = await client.requestJson({
          method: 'POST',
          path: '/v1/runner/leases:acquire',
          body: {
            workerId: config.workerId,
            capabilities: config.capabilities,
            waitMs: config.pollWaitMs,
          },
          timeoutMs: Math.max(config.requestTimeoutMs, config.pollWaitMs + 5_000),
          signal: acquireSignal,
        });
      } catch (err: unknown) {
        if (preemptSignal.aborted) {
          return { polls, jobsProcessed, lastSettlement, exitReason: 'preempted' };
        }
        if (shutdownSignal.aborted) {
          return { polls, jobsProcessed, lastSettlement, exitReason: 'aborted' };
        }
        if (err instanceof HardwareRunnerError && (err.code === 'AUTH_UNAUTHORIZED' || err.code === 'AUTH_FORBIDDEN')) {
          throw err;
        }
        if (options.once === true) {
          throw err;
        }
        await sleepAbortable(options.idleRetryDelayMs ?? 200, acquireSignal);
        continue;
      }

      if (acquireRes.status === 204) {
        if (options.once === true) {
          return { polls, jobsProcessed, lastSettlement, exitReason: 'once_idle' };
        }
        if (config.pollWaitMs === 0) {
          await sleepAbortable(options.idleRetryDelayMs ?? 50, acquireSignal);
        }
        continue;
      }

      if (acquireRes.status !== 200) {
        const mappedAcquireErr = mapHttpError(acquireRes.status, acquireRes.bytes, 'failed to acquire worker lease');
        if (
          options.once !== true
          && (acquireRes.status === 429 || acquireRes.status === 502 || acquireRes.status === 503 || acquireRes.status === 504)
        ) {
          await sleepAbortable(options.idleRetryDelayMs ?? 200, acquireSignal);
          continue;
        }
        throw mappedAcquireErr;
      }

      const grant = parseLeaseGrantPayload(acquireRes.bytes, OVERLAY_LIMITS.maxMaxBytes);
      const creds: LeaseCredentials = {
        relayBootId: grant.relayBootId,
        leaseEpoch: grant.leaseEpoch,
        leaseToken: grant.leaseToken,
      };

      const scrubber = new SecretScrubber();
      scrubber.register(config.workerToken);
      scrubber.register(grant.leaseToken);

      // Anchor conservative initial lease deadline strictly to acquireSentMono (pre-request)!
      // Never anchor to receipt time without a verified send-anchored renewal.
      const initialSafetyMarginMs = computeConservativeLeaseMarginMs(grant.leaseTtlMs);
      let localLeaseDeadlineMono = acquireSentMono + grant.leaseTtlMs - initialSafetyMarginMs;
      let effectiveHbMs = Math.max(
        15,
        Math.min(config.heartbeatIntervalMs, Math.floor(grant.leaseTtlMs / 3)),
      );

      const jobAbort = new AbortController();
      const watchAbort = new AbortController();
      let wakeHeartbeatNow: (() => void) | null = null;
      type JobAbortCause = 'none' | 'preempt' | 'cancel' | 'fenced' | 'shutdown';
      const abortState: { cause: JobAbortCause } = { cause: 'none' };

      const triggerAbort = (cause: Exclude<JobAbortCause, 'none'>) => {
        if (abortState.cause === 'none' || (cause === 'preempt' && abortState.cause !== 'fenced')) {
          abortState.cause = cause;
        }
        jobAbort.abort();
        watchAbort.abort();
        wakeHeartbeatNow?.();
      };

      let leaseDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const clearLeaseDeadlineTimer = () => {
        if (leaseDeadlineTimer !== null) {
          clearTimeout(leaseDeadlineTimer);
          leaseDeadlineTimer = null;
        }
      };
      const scheduleLeaseDeadlineTimer = () => {
        clearLeaseDeadlineTimer();
        if (jobAbort.signal.aborted) return;
        const remainingMs = localLeaseDeadlineMono - clock.nowMonotonicMs();
        if (remainingMs <= 0) {
          triggerAbort('fenced');
          return;
        }
        leaseDeadlineTimer = setTimeout(() => {
          if (!jobAbort.signal.aborted && clock.nowMonotonicMs() >= localLeaseDeadlineMono) {
            triggerAbort('fenced');
          } else if (!jobAbort.signal.aborted) {
            scheduleLeaseDeadlineTimer();
          }
        }, Math.max(1, Math.ceil(remainingMs)));
        leaseDeadlineTimer.unref();
      };

      const assertAuthorityLive = (): boolean => {
        if (clock.nowMonotonicMs() >= localLeaseDeadlineMono) {
          triggerAbort('fenced');
          return false;
        }
        return !jobAbort.signal.aborted;
      };

      const onJobPreempt = () => triggerAbort('preempt');
      const onJobShutdown = () => triggerAbort('shutdown');
      if (preemptSignal.aborted) {
        triggerAbort('preempt');
      } else {
        preemptSignal.addEventListener('abort', onJobPreempt, { once: true });
      }
      if (!jobAbort.signal.aborted && shutdownSignal.aborted) {
        triggerAbort('shutdown');
      } else {
        shutdownSignal.addEventListener('abort', onJobShutdown, { once: true });
      }

      let evaluated: EvaluatedBenchmarkJob | null = null;
      let evaluatorInfraError: HardwareRunnerError | null = null;
      let teardownFailure: HardwareRunnerError | null = null;

      // If long-poll turnaround consumed a substantial share of the lease (leaving <= max(safetyMargin, effectiveHbMs, leaseTtlMs/3)
      // before conservative local expiry, or already past localLeaseDeadlineMono), require an immediate request-send-anchored
      // :heartbeat renewal BEFORE starting the evaluator!
      const preStartRenewalThresholdMs = Math.max(
        initialSafetyMarginMs,
        effectiveHbMs,
        Math.floor(grant.leaseTtlMs / 3),
      );
      if (!jobAbort.signal.aborted && localLeaseDeadlineMono - clock.nowMonotonicMs() <= preStartRenewalThresholdMs) {
        const preHbSentMono = clock.nowMonotonicMs();
        try {
          const preHbRes = await client.requestJson({
            method: 'POST',
            path: `/v1/runner/leases/${encodeURIComponent(grant.jobId)}:heartbeat`,
            body: {
              relayBootId: creds.relayBootId,
              leaseEpoch: creds.leaseEpoch,
              leaseToken: creds.leaseToken,
              state: 'running',
            },
            timeoutMs: Math.min(config.requestTimeoutMs, Math.max(50, grant.leaseTtlMs)),
            signal: jobAbort.signal,
          });
          if (preHbRes.status === 409) {
            const errCode = parseErrorCodeFromJson(preHbRes.bytes);
            if (errCode === 'QUEUE_LEASE_FENCED' || errCode === null) {
              triggerAbort('fenced');
            } else {
              evaluatorInfraError = mapHttpError(preHbRes.status, preHbRes.bytes, 'pre-start lease renewal failed');
            }
          } else if (preHbRes.status === 200) {
            const parsedPreHb = validateHeartbeatResponsePayload(preHbRes.bytes, creds.leaseEpoch);
            if (parsedPreHb.desiredState === 'cancel') {
              triggerAbort('cancel');
            } else {
              const renewedMono =
                preHbSentMono + parsedPreHb.leaseTtlMs - computeConservativeLeaseMarginMs(parsedPreHb.leaseTtlMs);
              if (renewedMono <= clock.nowMonotonicMs()) {
                triggerAbort('fenced');
              } else {
                localLeaseDeadlineMono = renewedMono;
                effectiveHbMs = Math.max(
                  15,
                  Math.min(config.heartbeatIntervalMs, Math.floor(parsedPreHb.leaseTtlMs / 3)),
                );
              }
            }
          } else {
            evaluatorInfraError = mapHttpError(preHbRes.status, preHbRes.bytes, 'pre-start lease renewal failed');
          }
        } catch (preHbErr: unknown) {
          if (preHbErr instanceof HardwareRunnerError && preHbErr.code === 'QUEUE_LEASE_FENCED') {
            triggerAbort('fenced');
          } else if (!jobAbort.signal.aborted) {
            evaluatorInfraError = preHbErr instanceof HardwareRunnerError
              ? preHbErr
              : new RunnerTransportError(
                  preHbErr instanceof Error ? preHbErr.message : 'pre-start lease renewal failed',
                );
          }
        }
      }

      if (evaluatorInfraError === null && !jobAbort.signal.aborted) {
        scheduleLeaseDeadlineTimer();
      }

      if (options.onLeaseAcquired !== undefined) {
        await options.onLeaseAcquired(grant);
      }

      let hbStopped = false;
      let immediateHbRequested = false;

      const waitNextHeartbeatTick = (ms: number): Promise<void> => {
        if (hbStopped || jobAbort.signal.aborted || immediateHbRequested) {
          immediateHbRequested = false;
          return Promise.resolve();
        }
        return new Promise<void>(resolveWait => {
          const finishWait = () => {
            clearTimeout(t);
            jobAbort.signal.removeEventListener('abort', finishWait);
            wakeHeartbeatNow = null;
            immediateHbRequested = false;
            resolveWait();
          };
          const t = setTimeout(finishWait, ms);
          t.unref();
          wakeHeartbeatNow = finishWait;
          jobAbort.signal.addEventListener('abort', finishWait, { once: true });
        });
      };

      const heartbeatLoop = evaluatorInfraError === null
        ? (async () => {
            while (!hbStopped && !jobAbort.signal.aborted) {
              await waitNextHeartbeatTick(effectiveHbMs);
              if (hbStopped || jobAbort.signal.aborted) break;
              if (!assertAuthorityLive()) break;

              const hbStartedMono = clock.nowMonotonicMs();
              const remainingBudgetMs = Math.max(25, Math.ceil(localLeaseDeadlineMono - hbStartedMono));
              try {
                const hbRes = await client.requestJson({
                  method: 'POST',
                  path: `/v1/runner/leases/${encodeURIComponent(grant.jobId)}:heartbeat`,
                  body: {
                    relayBootId: creds.relayBootId,
                    leaseEpoch: creds.leaseEpoch,
                    leaseToken: creds.leaseToken,
                    state: 'running',
                  },
                  timeoutMs: Math.min(config.requestTimeoutMs, remainingBudgetMs),
                  signal: jobAbort.signal,
                });
                if (hbRes.status === 409) {
                  const errCode = parseErrorCodeFromJson(hbRes.bytes);
                  if (errCode === 'QUEUE_LEASE_FENCED' || errCode === null) {
                    triggerAbort('fenced');
                    break;
                  }
                  continue;
                }
                if (hbRes.status === 200) {
                  const parsedHb = validateHeartbeatResponsePayload(hbRes.bytes, creds.leaseEpoch);
                  if (parsedHb.desiredState === 'cancel') {
                    triggerAbort('cancel');
                    break;
                  }
                  // Anchor renewal strictly to hbStartedMono and honor BOTH extensions AND shorter TTL renewals!
                  localLeaseDeadlineMono =
                    hbStartedMono + parsedHb.leaseTtlMs - computeConservativeLeaseMarginMs(parsedHb.leaseTtlMs);
                  effectiveHbMs = Math.max(
                    15,
                    Math.min(config.heartbeatIntervalMs, Math.floor(parsedHb.leaseTtlMs / 3)),
                  );
                  scheduleLeaseDeadlineTimer();
                }
              } catch (hbErr: unknown) {
                if (hbErr instanceof HardwareRunnerError && hbErr.code === 'QUEUE_LEASE_FENCED') {
                  triggerAbort('fenced');
                  break;
                }
                if (!assertAuthorityLive()) break;
              }
            }
          })()
        : Promise.resolve();

      const sseWatchPromise = options.enableSseEvents !== false && evaluatorInfraError === null
        ? client.watchCancelEvents({
            jobId: grant.jobId,
            creds,
            signal: watchAbort.signal,
            onCancel: () => triggerAbort('cancel'),
            onFenced: () => triggerAbort('fenced'),
            onDisconnected: () => {
              immediateHbRequested = true;
              wakeHeartbeatNow?.();
            },
          })
        : Promise.resolve();

      try {
        if (evaluatorInfraError === null && assertAuthorityLive()) {
          evaluated = await evaluator({
            config,
            grant,
            signal: jobAbort.signal,
            getLeaseDeadlineMonoMs: () => localLeaseDeadlineMono,
            nowMonotonicMs: () => clock.nowMonotonicMs(),
            ...(options.probe !== undefined ? { probe: options.probe } : {}),
            downloadInputBlob: async (sha256, expectedByteLength, onChunk) => {
              if (!assertAuthorityLive()) {
                throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'local lease authority expired before blob download');
              }
              try {
                await client.downloadBlobToStream({
                  jobId: grant.jobId,
                  creds,
                  sha256,
                  expectedByteLength,
                  timeoutMs: config.requestTimeoutMs,
                  signal: jobAbort.signal,
                  onChunk,
                });
              } catch (dlErr: unknown) {
                if (dlErr instanceof HardwareRunnerError && dlErr.code === 'QUEUE_LEASE_FENCED') {
                  triggerAbort('fenced');
                }
                throw dlErr;
              }
            },
          });
        }
      } catch (evalErr: unknown) {
        if (isRunnerTeardownError(evalErr)) {
          teardownFailure = evalErr instanceof HardwareRunnerError
            ? evalErr
            : new RunnerTeardownError(evalErr instanceof Error ? evalErr.message : String(evalErr));
        } else if (evalErr instanceof HardwareRunnerError && evalErr.code === 'QUEUE_LEASE_FENCED') {
          triggerAbort('fenced');
        } else if (!jobAbort.signal.aborted) {
          if (
            evalErr instanceof HardwareRunnerError
            && !isRunnerTransportError(evalErr)
            && DETERMINISTIC_EVAL_ERROR_CODES.has(evalErr.code)
          ) {
            const safeDetail = scrubber.scrub(evalErr.message).trim() || evalErr.code;
            evaluated = {
              status: 'denied',
              reason: evalErr.code,
              detail: safeDetail,
              findings: Object.freeze([
                Object.freeze({
                  title: `Benchmark job rejected (${evalErr.code})`,
                  severity: 'high' as const,
                  evidence: safeDetail,
                }),
              ]),
              sealedOutputs: Object.freeze([]),
              cleanup: async () => {},
            };
          } else if (evalErr instanceof HardwareRunnerError) {
            evaluatorInfraError = evalErr;
          } else {
            evaluatorInfraError = new HardwareRunnerError(
              'RUNNER_SANDBOX_FAILED',
              evalErr instanceof Error ? evalErr.message : 'worker evaluation failed',
            );
          }
        }
      }

      let ackedOutputCount = 0;
      let unackedUploadFailure = false;
      let jobCleanupAttempted = false;
      let forcePreemptForExternalDeviceLoss = false;
      const shouldPreserveSealedOutputs = (): boolean => {
        if (evaluated === null || evaluated.sealedOutputs.length === 0) {
          return false;
        }
        if (unackedUploadFailure) {
          return true;
        }
        if (
          forcePreemptForExternalDeviceLoss
          || abortState.cause === 'preempt'
          || preemptSignal.aborted
          || abortState.cause === 'cancel'
          || abortState.cause === 'shutdown'
          || shutdownSignal.aborted
          || abortState.cause === 'fenced'
        ) {
          return false;
        }
        return ackedOutputCount < evaluated.sealedOutputs.length;
      };

      const runEvaluatedCleanupOnce = async (preserveSealedOutputs: boolean): Promise<void> => {
        if (evaluated !== null && !jobCleanupAttempted) {
          jobCleanupAttempted = true;
          try {
            await evaluated.cleanup(preserveSealedOutputs ? { preserveSealedOutputs: true } : undefined);
          } catch (cleanErr: unknown) {
            const wrapped = cleanErr instanceof RunnerTeardownError
              ? cleanErr
              : new RunnerTeardownError(
                  cleanErr instanceof Error ? cleanErr.message : 'failed to clean up job workspace',
                );
            teardownFailure ??= wrapped;
          }
        }
      };

      let bodyLoopErr: unknown = null;
      try {
        // Post-crash / post-timeout out-of-band accelerator health probe MUST execute BEFORE reporting
        // completion/preemption or polling `/v1/runner/leases:acquire` for another job!
        const stageBCrashedOrTimedOut =
          teardownFailure === null
          && evaluatorInfraError === null
          && evaluated !== null
          && (
            evaluated.stageBFailure !== undefined
            || evaluated.reason === 'STAGE_B_TIMEOUT'
            || evaluated.reason === 'STAGE_B_EXECUTION_FAILED'
          );

        if (stageBCrashedOrTimedOut && evaluated !== null && !shutdownSignal.aborted) {
          let healthResult: AcceleratorHealthProbeResult;
          try {
            healthResult = await healthProbeRunner({
              probeMode: config.probeMode,
              capabilities: config.capabilities,
              targetHardware: grant.job.targetHardware,
              scrubber,
            });
          } catch (probeErr: unknown) {
            const safeProbeErr = scrubber.scrub(probeErr instanceof Error ? probeErr.message : String(probeErr)).trim()
              || 'post-crash accelerator health probe failed';
            healthResult = Object.freeze({
              healthy: false,
              quarantineRequired: true,
              probeKind: config.probeMode,
              vendor: 'synthetic',
              checkedDeviceIndices: Object.freeze([0]),
              faultKind: 'probe_failed',
              summary: safeProbeErr,
              findings: Object.freeze([
                Object.freeze({
                  title: 'Post-crash accelerator health probe failed',
                  severity: 'critical' as const,
                  evidence: safeProbeErr,
                }),
              ]),
            });
          }

          if (!healthResult.healthy || healthResult.quarantineRequired) {
            const safeSummary =
              scrubber.scrub(healthResult.summary).trim()
              || 'worker accelerator device quarantined after Stage B crash/timeout';
            quarantineError = new HardwareRunnerError('WORKER_DEVICE_QUARANTINED', safeSummary);

            if (healthResult.externalHostLoss === true) {
              forcePreemptForExternalDeviceLoss = true;
            } else if (healthResult.findings.length > 0) {
              const scrubbedHealthFindings: StructuredFinding[] = healthResult.findings.map(f => {
                const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
                copy.title = (scrubber.scrub(f.title).trim() || 'Accelerator fault').slice(0, LIMITS.findingTitle);
                copy.severity = f.severity;
                copy.evidence = (scrubber.scrub(f.evidence).trim() || safeSummary).slice(0, LIMITS.findingEvidence);
                return Object.freeze(copy as unknown as StructuredFinding);
              });
              const existingFindings = evaluated.findings ?? [];
              const keepCount = Math.max(0, LIMITS.findings - scrubbedHealthFindings.length);
              evaluated = Object.freeze({
                ...evaluated,
                findings: Object.freeze([
                  ...existingFindings.slice(0, keepCount),
                  ...scrubbedHealthFindings.slice(0, LIMITS.findings),
                ]),
              });
            }
          }
        }

        // Upload sealed Stage A output blobs while heartbeat and local lease authority remain active.
        if (
          !forcePreemptForExternalDeviceLoss
          && teardownFailure === null
          && evaluated !== null
          && evaluatorInfraError === null
          && assertAuthorityLive()
        ) {
          for (const sealed of evaluated.sealedOutputs) {
            if (!assertAuthorityLive()) break;
            try {
              await client.uploadBlobFromFile({
                jobId: grant.jobId,
                creds,
                filePath: sealed.sealedFilePath,
                sha256: sealed.artifact.digest.hex,
                expectedByteLength: sealed.artifact.byteLength,
                timeoutMs: Math.max(config.requestTimeoutMs, 60_000),
                signal: jobAbort.signal,
              });
              ackedOutputCount += 1;
            } catch (ulErr: unknown) {
              if (ulErr instanceof HardwareRunnerError && ulErr.code === 'QUEUE_LEASE_FENCED') {
                triggerAbort('fenced');
                break;
              }
              if (!jobAbort.signal.aborted) {
                unackedUploadFailure = true;
                throw ulErr;
              }
            }
          }
        }

        // Remove disposable local job scratch directories BEFORE settling (:preempt or :complete);
        // only remove sealed outputs once every required output blob is remoteAcked (or no unacked upload is pending)!
        await runEvaluatedCleanupOnce(shouldPreserveSealedOutputs());

        watchAbort.abort();
        await sseWatchPromise.catch(() => {});

        // NEVER send confirmed :preempt or :complete when process/container/workspace teardown failed!
        if (teardownFailure !== null) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});
          lastSettlement = Object.freeze({
            jobId: grant.jobId,
            operationId: grant.operationId,
            leaseEpoch: grant.leaseEpoch,
            outcome: 'unknown',
            acknowledgment: 'local_only',
            relayErrorCode: teardownFailure.code,
          });
          if (options.onJobSettled !== undefined) {
            await options.onJobSettled(lastSettlement);
          }
          throw teardownFailure;
        }

        if (abortState.cause === 'preempt' || preemptSignal.aborted || forcePreemptForExternalDeviceLoss) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});

          let preemptSummary: WorkerJobSettlementSummary;
          try {
            const preemptRes = await client.requestJson({
              method: 'POST',
              path: `/v1/runner/leases/${encodeURIComponent(grant.jobId)}:preempt`,
              body: {
                relayBootId: creds.relayBootId,
                leaseEpoch: creds.leaseEpoch,
                leaseToken: creds.leaseToken,
                reason: forcePreemptForExternalDeviceLoss ? 'worker_device_lost' : 'worker_preempted',
              },
              timeoutMs: config.requestTimeoutMs,
            });
            if (preemptRes.status === 200) {
              const parsedPreempt = validatePreemptResponsePayload(preemptRes.bytes, grant.job);
              preemptSummary = Object.freeze({
                jobId: grant.jobId,
                operationId: grant.operationId,
                leaseEpoch: grant.leaseEpoch,
                outcome: 'preempted',
                acknowledgment: 'confirmed',
                preemptionStatus: parsedPreempt.status,
                preemptionCount: parsedPreempt.preemptionCount,
              });
            } else {
              const errCode = parseErrorCodeFromJson(preemptRes.bytes);
              if (preemptRes.status === 409 && errCode === 'QUEUE_LEASE_FENCED') {
                preemptSummary = Object.freeze({
                  jobId: grant.jobId,
                  operationId: grant.operationId,
                  leaseEpoch: grant.leaseEpoch,
                  outcome: 'fenced',
                  acknowledgment: 'fenced',
                  relayErrorCode: 'QUEUE_LEASE_FENCED',
                });
              } else {
                preemptSummary = Object.freeze({
                  jobId: grant.jobId,
                  operationId: grant.operationId,
                  leaseEpoch: grant.leaseEpoch,
                  outcome: 'unknown',
                  acknowledgment: 'unknown',
                  ...(errCode !== null ? { relayErrorCode: errCode } : {}),
                });
              }
            }
          } catch (preemptErr: unknown) {
            if (!wasRequestSent(preemptErr)) {
              throw preemptErr;
            }
            preemptSummary = Object.freeze({
              jobId: grant.jobId,
              operationId: grant.operationId,
              leaseEpoch: grant.leaseEpoch,
              outcome: 'unknown',
              acknowledgment: 'unknown',
              ...(preemptErr instanceof HardwareRunnerError ? { relayErrorCode: preemptErr.code } : {}),
            });
          }

          lastSettlement = preemptSummary;
          if (options.onJobSettled !== undefined) {
            await options.onJobSettled(lastSettlement);
          }
          if (quarantineError !== null) {
            throw quarantineError;
          }
          return { polls, jobsProcessed, lastSettlement, exitReason: 'preempted' };
        }

        // Never call :preempt on infrastructure/sandbox errors (eviction budget is strictly for real preemption!).
        if (evaluatorInfraError !== null) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});
          throw evaluatorInfraError;
        }

        // Handle local graceful shutdown (SIGINT / caller stopSignal) BEFORE checking assertAuthorityLive()
        // so local cancellation never masquerades as a Relay fence!
        if (abortState.cause === 'shutdown' || shutdownSignal.aborted) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});
          lastSettlement = Object.freeze({
            jobId: grant.jobId,
            operationId: grant.operationId,
            leaseEpoch: grant.leaseEpoch,
            outcome: 'cancelled',
            acknowledgment: 'local_only',
          });
          if (options.onJobSettled !== undefined) {
            await options.onJobSettled(lastSettlement);
          }
          return { polls, jobsProcessed, lastSettlement, exitReason: 'aborted' };
        }

        if (abortState.cause === 'cancel' || abortState.cause === 'fenced' || !assertAuthorityLive()) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});
          const isCancel = abortState.cause === 'cancel';
          lastSettlement = Object.freeze({
            jobId: grant.jobId,
            operationId: grant.operationId,
            leaseEpoch: grant.leaseEpoch,
            outcome: isCancel ? 'cancelled' : 'fenced',
            acknowledgment: isCancel ? 'local_only' : 'fenced',
          });
          if (options.onJobSettled !== undefined) {
            await options.onJobSettled(lastSettlement);
          }
          if (quarantineError !== null) {
            throw quarantineError;
          }
          if (options.once === true) {
            return { polls, jobsProcessed, lastSettlement, exitReason: 'once_completed' };
          }
          continue;
        }

        if (evaluated === null) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});
          if (quarantineError !== null) {
            throw quarantineError;
          }
          return { polls, jobsProcessed, lastSettlement, exitReason: 'aborted' };
        }

        const completeBody: CompleteLeaseInput = {
          relayBootId: creds.relayBootId,
          leaseEpoch: creds.leaseEpoch,
          leaseToken: creds.leaseToken,
          status: evaluated.status,
          reason: evaluated.reason,
          ...(evaluated.detail !== undefined ? { detail: evaluated.detail } : {}),
          ...(evaluated.metrics !== undefined ? { metrics: evaluated.metrics } : {}),
          ...(evaluated.findings !== undefined ? { findings: evaluated.findings } : {}),
          ...(evaluated.hardwareProvenance !== undefined ? { hardwareProvenance: evaluated.hardwareProvenance } : {}),
          ...(evaluated.bucketMetrics !== undefined ? { bucketMetrics: evaluated.bucketMetrics } : {}),
          ...(evaluated.hardwareDiagnostics !== undefined ? { hardwareDiagnostics: evaluated.hardwareDiagnostics } : {}),
          ...(evaluated.sealedOutputs.length > 0
            ? { outputArtifacts: evaluated.sealedOutputs.map(item => item.artifact) }
            : {}),
        };

        let completeRes: { readonly status: number; readonly bytes: Buffer };
        try {
          completeRes = await client.requestJson({
            method: 'POST',
            path: `/v1/runner/leases/${encodeURIComponent(grant.jobId)}:complete`,
            body: completeBody,
            timeoutMs: config.requestTimeoutMs,
          });
        } catch (completeTransportErr: unknown) {
          hbStopped = true;
          clearLeaseDeadlineTimer();
          jobAbort.abort();
          await heartbeatLoop.catch(() => {});
          // Only publish 'unknown' when the HTTP request was actually dispatched over the wire!
          if (wasRequestSent(completeTransportErr)) {
            lastSettlement = Object.freeze({
              jobId: grant.jobId,
              operationId: grant.operationId,
              leaseEpoch: grant.leaseEpoch,
              outcome: 'unknown',
              acknowledgment: 'unknown',
              ...(completeTransportErr instanceof HardwareRunnerError
                ? { relayErrorCode: completeTransportErr.code }
                : {}),
            });
            if (options.onJobSettled !== undefined) {
              await options.onJobSettled(lastSettlement);
            }
          }
          throw completeTransportErr;
        }

        hbStopped = true;
        clearLeaseDeadlineTimer();
        jobAbort.abort();
        await heartbeatLoop.catch(() => {});

        if (completeRes.status !== 200) {
          const remoteErrCode = parseErrorCodeFromJson(completeRes.bytes);
          if (completeRes.status === 409 && remoteErrCode === 'QUEUE_LEASE_FENCED') {
            lastSettlement = Object.freeze({
              jobId: grant.jobId,
              operationId: grant.operationId,
              leaseEpoch: grant.leaseEpoch,
              outcome: 'fenced',
              acknowledgment: 'fenced',
              relayErrorCode: 'QUEUE_LEASE_FENCED',
            });
            if (options.onJobSettled !== undefined) {
              await options.onJobSettled(lastSettlement);
            }
            if (quarantineError !== null) {
              throw quarantineError;
            }
            if (options.once === true) {
              return { polls, jobsProcessed, lastSettlement, exitReason: 'once_completed' };
            }
            continue;
          }
          const mappedCompleteErr = mapHttpError(
            completeRes.status,
            completeRes.bytes,
            `failed to complete lease ${grant.jobId}`,
          );
          if (completeRes.status >= 500 || completeRes.status === 408 || completeRes.status === 429) {
            lastSettlement = Object.freeze({
              jobId: grant.jobId,
              operationId: grant.operationId,
              leaseEpoch: grant.leaseEpoch,
              outcome: 'unknown',
              acknowledgment: 'unknown',
              relayErrorCode: mappedCompleteErr.code,
            });
            if (options.onJobSettled !== undefined) {
              await options.onJobSettled(lastSettlement);
            }
          }
          throw mappedCompleteErr;
        }

        try {
          validateCompleteResponsePayload(completeRes.bytes, grant.operationId, evaluated.status);
        } catch (completeReceiptErr: unknown) {
          lastSettlement = Object.freeze({
            jobId: grant.jobId,
            operationId: grant.operationId,
            leaseEpoch: grant.leaseEpoch,
            outcome: 'unknown',
            acknowledgment: 'unknown',
            ...(completeReceiptErr instanceof HardwareRunnerError
              ? { relayErrorCode: completeReceiptErr.code }
              : {}),
          });
          if (options.onJobSettled !== undefined) {
            await options.onJobSettled(lastSettlement);
          }
          throw completeReceiptErr;
        }

        jobsProcessed += 1;
        lastSettlement = Object.freeze({
          jobId: grant.jobId,
          operationId: grant.operationId,
          leaseEpoch: grant.leaseEpoch,
          outcome: 'completed',
          acknowledgment: 'confirmed',
          status: evaluated.status,
        });
        if (options.onJobSettled !== undefined) {
          await options.onJobSettled(lastSettlement);
        }

        if (quarantineError !== null) {
          throw quarantineError;
        }

        if (options.once === true) {
          return { polls, jobsProcessed, lastSettlement, exitReason: 'once_completed' };
        }
      } catch (loopErr: unknown) {
        bodyLoopErr = loopErr;
      } finally {
        hbStopped = true;
        clearLeaseDeadlineTimer();
        watchAbort.abort();
        jobAbort.abort();
        preemptSignal.removeEventListener('abort', onJobPreempt);
        shutdownSignal.removeEventListener('abort', onJobShutdown);
        await Promise.allSettled([heartbeatLoop, sseWatchPromise]);
        if (evaluated !== null && !jobCleanupAttempted) {
          await runEvaluatedCleanupOnce(shouldPreserveSealedOutputs());
        }
      }
      if (teardownFailure !== null && !isRunnerTeardownError(bodyLoopErr)) {
        throw teardownFailure;
      }
      if (bodyLoopErr !== null) {
        throw bodyLoopErr;
      }
    }
  } finally {
    if (options.registerProcessSignalHandlers !== false) {
      process.removeListener('SIGTERM', onSigTerm);
      process.removeListener('SIGINT', onSigInt);
    }
    client.close();
  }
}
