import type { ArtifactRef, Digest, RunResult } from '@loopwright/core';
import { ControllerFailure, type ControllerDiagnostic } from './errors.js';
import { canonical, freeze } from './schema.js';
import type { ArtifactStore } from './storage.js';
export interface ControllerIncident {
  readonly version: 1; readonly code: ControllerDiagnostic['code']; readonly runId: string; readonly lockHash: Digest;
  readonly stage: ControllerDiagnostic['phase']; readonly knownReferences: readonly ArtifactRef[]; readonly unavailable: readonly string[];
  readonly cleanup: 'complete' | 'pending' | 'failed';
}
export type CycleExecution = { readonly kind: 'result'; readonly version: 1; readonly runId: string; readonly result: RunResult;
  readonly observations: ArtifactRef | null; readonly secondary: readonly ControllerDiagnostic['code'][] }
  | { readonly kind: 'incident'; readonly version: 1; readonly incident: ControllerIncident };
export function incident(diagnostic: ControllerDiagnostic, runId: string, lockHash: Digest, references: readonly ArtifactRef[], unavailable: readonly string[], cleanup: ControllerIncident['cleanup']): ControllerIncident {
  return freeze({ version: 1, code: diagnostic.code, runId, lockHash, stage: diagnostic.phase, knownReferences: [...references], unavailable: [...unavailable], cleanup });
}
/** A single immutable primary; bounded secondary writes cannot change it. No finalizer model or allowance. */
export class Finalizer {
  readonly started = performance.now(); #bytes = 0; readonly #deadline: number;
  constructor(readonly artifacts: ArtifactStore, remainingMs: number) { this.#deadline = this.started + Math.min(15000, Math.max(0, remainingMs)); }
  reserve(bytes: number): void {
    this.#bytes += bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#bytes > 1048576 || performance.now() >= this.#deadline) throw new ControllerFailure({ version: 1, code: 'OUTPUT_LIMIT', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false });
  }
  check(): void { this.reserve(0); }
  async put(kind: string, value: unknown): Promise<ArtifactRef> {
    const bytes = Buffer.from(canonical(value)); this.reserve(bytes.byteLength);
    const ref = await this.artifacts.put(kind, bytes, 1048576);
    // Await the exact bounded write and close; a late write is retained but cannot authorize another write.
    if (performance.now() >= this.#deadline) throw new ControllerFailure({ version: 1, code: 'DEADLINE', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'none', retryable: false }); return ref;
  }
}
