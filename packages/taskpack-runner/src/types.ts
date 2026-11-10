/** Typed failure codes for the frozen corpus and the contained Python bridge. */
export type RunnerTaskpackErrorCode =
  | 'CORPUS_TAMPERED'
  | 'CORPUS_UNAVAILABLE'
  | 'PYTHON_UNAVAILABLE'
  | 'PYTHON_BOUNDARY'
  | 'PYTHON_TIMEOUT'
  | 'INTAKE_BLOCKED'
  | 'CONFIG_INVALID'
  | 'SERVICE_FAULT';

/** Explicit, matchable failure with the offending corpus or request path when known. */
export class RunnerTaskpackError extends Error {
  readonly code: RunnerTaskpackErrorCode;
  readonly path: string | null;
  constructor(code: RunnerTaskpackErrorCode, message: string, path: string | null = null) {
    super(message);
    this.name = 'RunnerTaskpackError';
    this.code = code;
    this.path = path;
  }
}

/** One hash-pinned frozen file recorded by the vendored corpus manifest. */
export interface FrozenCorpusEntry {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly executable: boolean;
}

/** Committed inventory of the exact frozen upstream revision inside `vendor/runner-auto-sync/`. */
export interface FrozenCorpusManifest {
  readonly version: 1;
  readonly sourceRepository: string;
  readonly sourceRevision: string;
  readonly files: readonly FrozenCorpusEntry[];
}

/** Successful verification: the trusted manifest plus the digest that pins the whole corpus. */
export interface FrozenCorpusVerification {
  readonly root: string;
  readonly manifest: FrozenCorpusManifest;
  readonly fileCount: number;
  readonly corpusDigest: string;
}
