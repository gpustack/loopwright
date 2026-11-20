import { TaskpackError } from './types.js';

const GENERIC_SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /ghs_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
]);
const MIN_FORM_LENGTH = 8;

/** Minimum sliding-window overlap in bytes when scanning or scrubbing streamed byte chunks. */
export const DEFAULT_STREAM_OVERLAP_BYTES = 16_384;

/**
 * Count trailing incomplete UTF-8 sequence bytes (`0..3`) at the end of a `Buffer`
 * so multi-byte codepoints split across chunk boundaries are decoded intact.
 */
function trailingIncompleteUtf8Bytes(buf: Buffer): number {
  const len = buf.byteLength;
  if (len === 0) return 0;
  const maxInspect = Math.min(3, len);
  for (let back = 1; back <= maxInspect; back += 1) {
    const b = buf[len - back]!;
    if ((b & 0x80) === 0x00) {
      // ASCII byte: any continuation bytes after it are invalid, not incomplete.
      return 0;
    }
    if ((b & 0xc0) === 0xc0) {
      // Lead byte of a multi-byte UTF-8 sequence.
      let expected: number;
      if ((b & 0xe0) === 0xc0) expected = 2;
      else if ((b & 0xf0) === 0xe0) expected = 3;
      else if ((b & 0xf8) === 0xf0) expected = 4;
      else return 0;
      return back < expected ? back : 0;
    }
    // Continuation byte (10xxxxxx): keep scanning backward for lead byte.
  }
  return 0;
}

/**
 * Back up `cutIndex` by at most 3 bytes to a UTF-8 character boundary so retaining
 * `buf.subarray(aligned)` keeps at least `buf.byteLength - cutIndex` bytes without
 * slicing inside a multi-byte UTF-8 character.
 */
function alignUtf8StartBackward(buf: Buffer, cutIndex: number): number {
  let idx = Math.max(0, Math.min(cutIndex, buf.byteLength));
  let steps = 0;
  while (idx > 0 && steps < 3 && (buf[idx]! & 0xc0) === 0x80) {
    idx -= 1;
    steps += 1;
  }
  return idx;
}

export interface StreamScrubberOptions {
  readonly minOverlapBytes?: number | undefined;
}

/** Stateful sliding-window scrubber and leak detector safe across arbitrary UTF-8 and 64 KiB chunk boundaries. */
export interface StreamSecretScrubber {
  readonly overlapBytes: number;
  /** Feed a chunk and return the safely-emittable scrubbed prefix; call `flushScrub()` after the final chunk. */
  scrubChunk(chunk: Uint8Array | string): string;
  /** Flush and scrub any buffered tail remaining after the final chunk. */
  flushScrub(): string;
  /** Feed a chunk and throw `TOKEN_SECRET_LEAK_DETECTED` if any secret form spans or appears in the window. */
  assertChunkClean(chunk: Uint8Array | string, path?: string): void;
  /** Flush any trailing incomplete UTF-8 tail and assert it is clean. */
  flushClean(path?: string): void;
}

/** Tracks credential material in raw, JSON-escaped, URL-encoded, and base64 forms and scrubs every form. */
export class SecretScrubber {
  readonly #forms = new Set<string>();
  readonly #rawSecrets = new Set<string>();
  #maxDerivedSecretBytes = 0;

  register(secret: string): void {
    if (typeof secret !== 'string' || secret.length === 0) return;
    if (secret.trim().length >= 4) {
      this.#rawSecrets.add(secret);
    }
    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret, 'utf8').toString('base64'),
    ];
    for (const form of forms) {
      if (form.length >= MIN_FORM_LENGTH) {
        this.#forms.add(form);
        const bytes = Buffer.byteLength(form, 'utf8');
        if (bytes > this.#maxDerivedSecretBytes) {
          this.#maxDerivedSecretBytes = bytes;
        }
      }
    }
  }

  /** Registered secret values and derived encoded forms for redaction verification gates. */
  get secretValues(): readonly string[] {
    return Object.freeze([...new Set([...this.#rawSecrets, ...this.#forms])]);
  }

  /** Maximum UTF-8 byte length among all registered derived secret forms. */
  get maxDerivedSecretBytes(): number {
    return this.#maxDerivedSecretBytes;
  }

  /** Required sliding-window byte overlap (`max(16_384, maxDerivedSecretBytes)`). */
  get streamOverlapBytes(): number {
    return Math.max(DEFAULT_STREAM_OVERLAP_BYTES, this.#maxDerivedSecretBytes);
  }

  /** Replace every tracked credential form and generic token pattern with `[scrubbed]`. */
  scrub(text: string): string {
    return this.#scrubInternal(text, false);
  }

  /** Return true when any tracked credential form or generic token pattern appears in `value`. */
  containsSecret(value: string): boolean {
    for (const form of this.#forms) {
      if (form.length >= MIN_FORM_LENGTH && value.includes(form)) {
        return true;
      }
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      if (new RegExp(pattern.source).test(value)) {
        return true;
      }
    }
    return false;
  }

  /** Throw `TOKEN_SECRET_LEAK_DETECTED` when any tracked form or generic pattern appears in a value. */
  assertClean(value: string | Uint8Array | object, path = '/artifact'): void {
    const serialized = value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
      : typeof value === 'string' ? value : JSON.stringify(value);
    for (const form of this.#forms) {
      if (form.length >= MIN_FORM_LENGTH && serialized.includes(form)) {
        throw new TaskpackError('TOKEN_SECRET_LEAK_DETECTED', `artifact contains tracked credential material at ${path}`, path);
      }
    }
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      if (new RegExp(pattern.source).test(serialized)) {
        throw new TaskpackError('TOKEN_SECRET_LEAK_DETECTED', `artifact contains a credential-shaped token at ${path}`, path);
      }
    }
  }

  /** Create a stateful sliding-window stream scrubber bound to this scrubber's secret registry. */
  createStreamScrubber(options: StreamScrubberOptions = {}): StreamSecretScrubber {
    const minOverlap = options.minOverlapBytes !== undefined && Number.isSafeInteger(options.minOverlapBytes) && options.minOverlapBytes > 0
      ? options.minOverlapBytes
      : DEFAULT_STREAM_OVERLAP_BYTES;
    const effectiveOverlap = (): number => Math.max(minOverlap, this.streamOverlapBytes);

    let scrubPending: Buffer = Buffer.alloc(0);
    let cleanPending: Buffer = Buffer.alloc(0);

    const toBuffer = (chunk: Uint8Array | string): Buffer => (
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    );

    return {
      get overlapBytes(): number {
        return effectiveOverlap();
      },

      scrubChunk: (chunk: Uint8Array | string): string => {
        const incoming = toBuffer(chunk);
        if (incoming.byteLength === 0) return '';
        const combined = scrubPending.byteLength === 0 ? incoming : Buffer.concat([scrubPending, incoming]);
        const incomplete = trailingIncompleteUtf8Bytes(combined);
        const completeLen = combined.byteLength - incomplete;
        if (completeLen <= 0) {
          scrubPending = combined;
          return '';
        }
        const completeText = combined.subarray(0, completeLen).toString('utf8');
        const scrubbedText = this.#scrubInternal(completeText, true);
        const scrubbedBuf = Buffer.from(scrubbedText, 'utf8');
        const overlap = effectiveOverlap();
        if (scrubbedBuf.byteLength <= overlap) {
          scrubPending = incomplete === 0
            ? scrubbedBuf
            : Buffer.concat([scrubbedBuf, combined.subarray(completeLen)]);
          return '';
        }
        const rawCut = scrubbedBuf.byteLength - overlap;
        const cut = alignUtf8StartBackward(scrubbedBuf, rawCut);
        const emitted = scrubbedBuf.subarray(0, cut).toString('utf8');
        const retained = scrubbedBuf.subarray(cut);
        scrubPending = incomplete === 0
          ? Buffer.from(retained)
          : Buffer.concat([retained, combined.subarray(completeLen)]);
        return emitted;
      },

      flushScrub: (): string => {
        if (scrubPending.byteLength === 0) return '';
        const text = scrubPending.toString('utf8');
        scrubPending = Buffer.alloc(0);
        return this.scrub(text);
      },

      assertChunkClean: (chunk: Uint8Array | string, path = '/artifact'): void => {
        const incoming = toBuffer(chunk);
        if (incoming.byteLength === 0) return;
        const combined = cleanPending.byteLength === 0 ? incoming : Buffer.concat([cleanPending, incoming]);
        const incomplete = trailingIncompleteUtf8Bytes(combined);
        const completeLen = combined.byteLength - incomplete;
        if (completeLen > 0) {
          const completeBuf = combined.subarray(0, completeLen);
          this.assertClean(completeBuf.toString('utf8'), path);
          const overlap = effectiveOverlap();
          const tailStart = completeLen > overlap ? alignUtf8StartBackward(completeBuf, completeLen - overlap) : 0;
          const retainedComplete = completeBuf.subarray(tailStart);
          cleanPending = incomplete === 0
            ? Buffer.from(retainedComplete)
            : Buffer.concat([retainedComplete, combined.subarray(completeLen)]);
        } else {
          cleanPending = combined;
        }
      },

      flushClean: (path = '/artifact'): void => {
        if (cleanPending.byteLength === 0) return;
        const text = cleanPending.toString('utf8');
        cleanPending = Buffer.alloc(0);
        this.assertClean(text, path);
      },
    };
  }

  #scrubInternal(text: string, deferEndTouchingGeneric: boolean): string {
    let output = text;
    if (this.#forms.size > 0) {
      // Replace longest registered forms first so prefixes cannot fragment longer secrets.
      const sortedForms = [...this.#forms].sort((a, b) => b.length - a.length);
      for (const form of sortedForms) {
        output = output.split(form).join('[scrubbed]');
      }
    }
    const overlap = this.streamOverlapBytes;
    const holdbackStart = Math.max(0, output.length - overlap);
    for (const pattern of GENERIC_SECRET_PATTERNS) {
      const regex = new RegExp(pattern.source, 'g');
      if (!deferEndTouchingGeneric) {
        output = output.replace(regex, '[scrubbed]');
      } else {
        output = output.replace(regex, (match: string, offset: number) => {
          // Defer generic token matches that touch the very end of the window inside the holdback
          // zone so tokens continuing in the next chunk are replaced atomically as one token.
          if (offset + match.length === output.length && offset >= holdbackStart) {
            return match;
          }
          return '[scrubbed]';
        });
      }
    }
    return output;
  }
}

/** Stand-alone leak check against generic credential patterns plus an optional scrubber's tracked forms. */
export function assertCleanArtifact(value: string | Uint8Array | object, scrubber?: SecretScrubber, path = '/artifact'): void {
  if (scrubber === undefined) {
    new SecretScrubber().assertClean(value, path);
    return;
  }
  scrubber.assertClean(value, path);
}

/** Create a standalone stateful sliding-window stream scrubber. */
export function createStreamScrubber(
  scrubber?: SecretScrubber,
  options?: StreamScrubberOptions,
): StreamSecretScrubber {
  return (scrubber ?? new SecretScrubber()).createStreamScrubber(options);
}

/** Convenience wrapper feeding one chunk into a `StreamSecretScrubber`. */
export function scrubStreamChunk(
  streamScrubber: StreamSecretScrubber,
  chunk: Uint8Array | string,
): string {
  return streamScrubber.scrubChunk(chunk);
}

/**
 * Stream-check an iterable or async iterable of byte/string chunks across sliding-window
 * boundaries (`>= max(16_384, maxDerivedSecretBytes)`) and fail closed with `TOKEN_SECRET_LEAK_DETECTED`.
 */
export async function assertStreamClean(
  chunks: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
  scrubber?: SecretScrubber,
  path = '/artifact',
): Promise<void> {
  const stream = createStreamScrubber(scrubber);
  for await (const chunk of chunks) {
    stream.assertChunkClean(chunk, path);
  }
  stream.flushClean(path);
}
