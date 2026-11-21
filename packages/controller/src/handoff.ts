import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import {
  LIMITS,
  SecretScrubber,
  type ArtifactRef,
  type StepHandoffSelect,
  type StepHandoffSelector,
  type StepHandoffSource,
} from '@loopwright/core';
import { ControllerFailure, refuse, type ControllerDiagnostic } from './errors.js';
import { copyVerifiedFileReadOnly } from './files.js';
import { parsePrivateJson } from './parser.js';
import { canonical, freeze, integer, type Json } from './schema.js';
import { resolveCanonicalCasBlobPath, type ArtifactStore } from './storage.js';
import { CONTROLLER_LIMITS, type AttemptHandoffExtract, type HandoffOmittedReason, type HandoffProvenance } from './types.js';

export const MAX_STEP_CONTEXT_FILES = CONTROLLER_LIMITS.maxStepContextFiles;

const FORBIDDEN_PROTOTYPE_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const NON_NEGATIVE_ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const DEFAULT_HANDOFF_SCRUBBER = new SecretScrubber();

export interface ExtractedSection {
  readonly content: string;
  readonly sourceSha256: string;
  readonly extractSha256: string;
  readonly byteLength: number;
  readonly truncated: boolean;
}

export interface ResolvedSelectorExtract {
  readonly provenance: HandoffProvenance;
  readonly content: string | null;
}

export interface UpstreamSourceLookupResult {
  readonly found: boolean;
  readonly bytes: Uint8Array | null;
  readonly fromAttemptId: string | null;
  readonly reworkEpoch?: number;
}

function ownUtf8View(
  rawUtf8: Uint8Array,
  diagPath = '',
  phase: ControllerDiagnostic['phase'] = 'execution',
): Uint8Array {
  if (
    !ArrayBuffer.isView(rawUtf8)
    || types.isProxy(rawUtf8)
    || ![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(rawUtf8))
    || types.isSharedArrayBuffer(rawUtf8.buffer)
  ) {
    refuse('ARTIFACT_INVALID', diagPath, phase);
  }
  if (rawUtf8.byteLength > LIMITS.handoffSourceBytes) {
    refuse('OUTPUT_LIMIT', diagPath, phase);
  }
  return new Uint8Array(rawUtf8.buffer, rawUtf8.byteOffset, rawUtf8.byteLength);
}

function decodeUtf8Strict(
  view: Uint8Array,
  diagPath = '',
  phase: ControllerDiagnostic['phase'] = 'execution',
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    refuse('ARTIFACT_INVALID', diagPath, phase);
  }
}

function validateMaxBytesOption(
  maxBytes: number,
  diagPath = '',
): number {
  return integer(maxBytes, LIMITS.handoffMinBytes, LIMITS.handoffMaxBytes, diagPath || '/maxBytes');
}

function stripOptionalClosingHashes(raw: string): string {
  const trimmed = raw.replace(/[ \t]+$/, '');
  if (/^#+$/.test(trimmed)) return '';
  return trimmed.replace(/[ \t]+#+$/, '').trim();
}

function finalizeExtractedSection(sectionText: string, sourceSha256: string, maxBytes: number): ExtractedSection {
  const fullBytes = Buffer.from(sectionText, 'utf8');
  if (fullBytes.byteLength <= maxBytes) {
    return Object.freeze({
      content: sectionText,
      sourceSha256,
      extractSha256: createHash('sha256').update(fullBytes).digest('hex'),
      byteLength: fullBytes.byteLength,
      truncated: false,
    });
  }
  let cut = maxBytes;
  while (cut > 0 && (fullBytes[cut]! & 0xc0) === 0x80) cut -= 1;
  const sliced = fullBytes.subarray(0, cut);
  return Object.freeze({
    content: sliced.toString('utf8'),
    sourceSha256,
    extractSha256: createHash('sha256').update(sliced).digest('hex'),
    byteLength: sliced.byteLength,
    truncated: true,
  });
}

/**
 * Decode a single RFC 6901 JSON Pointer (`~1` -> `/`, `~0` -> `~` in one pass),
 * rejecting invalid escapes, control bytes, and `__proto__` / `constructor` / `prototype` segments.
 */
export function decodeJsonPointer(
  pointer: string,
  diagPath = '',
  phase: ControllerDiagnostic['phase'] = 'configuration',
): readonly string[] {
  if (typeof pointer !== 'string' || pointer.length > LIMITS.handoffPointer || /[\0\r\n\p{C}]/u.test(pointer)) {
    refuse('CONFIG_SCHEMA', diagPath, phase);
  }
  if (pointer === '') return Object.freeze([]);
  if (!pointer.startsWith('/')) refuse('CONFIG_SCHEMA', diagPath, phase);
  const rawSegments = pointer.slice(1).split('/');
  if (rawSegments.length > LIMITS.segments) refuse('CONFIG_SCHEMA', diagPath, phase);
  const decodedSegments: string[] = [];
  for (const segment of rawSegments) {
    let decoded = '';
    for (let i = 0; i < segment.length; i += 1) {
      const ch = segment[i]!;
      if (ch === '~') {
        const next = segment[i + 1];
        if (next === '0') {
          decoded += '~';
          i += 1;
        } else if (next === '1') {
          decoded += '/';
          i += 1;
        } else {
          refuse('CONFIG_SCHEMA', diagPath, phase);
        }
      } else {
        decoded += ch;
      }
    }
    if (FORBIDDEN_PROTOTYPE_SEGMENTS.has(decoded)) {
      refuse('CONFIG_SCHEMA', diagPath, phase);
    }
    decodedSegments.push(decoded);
  }
  return Object.freeze(decodedSegments);
}

/**
 * Deterministic CommonMark-fence-aware ATX Markdown section extractor with SHA-256 provenance.
 */
export function extractMarkdownHeadingSection(
  rawUtf8: Uint8Array,
  targetHeading: string,
  options: { readonly includeSubheadings?: boolean; readonly maxBytes: number },
): ExtractedSection | null {
  const maxBytes = validateMaxBytesOption(options.maxBytes);
  if (typeof targetHeading !== 'string' || targetHeading.trim().length === 0 || targetHeading.length > LIMITS.handoffHeading) {
    refuse('CONFIG_SCHEMA', '/heading');
  }
  const view = ownUtf8View(rawUtf8, '/source', 'execution');
  const sourceSha256 = createHash('sha256').update(view).digest('hex');
  const text = decodeUtf8Strict(view, '/source', 'execution').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const explicitLevelMatch = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(targetHeading.trim());
  const requiredLevel = explicitLevelMatch ? explicitLevelMatch[1]!.length : null;
  const normalizedTarget = explicitLevelMatch
    ? stripOptionalClosingHashes(explicitLevelMatch[2] ?? '')
    : targetHeading.trim();
  if (normalizedTarget.length === 0) {
    refuse('CONFIG_SCHEMA', '/heading');
  }

  let fence: { readonly char: '`' | '~'; readonly length: number } | null = null;
  let startLine = -1;
  let startLevel = 0;
  let endLine = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      const char = marker[0] as '`' | '~';
      if (fence === null) {
        if (char === '~' || !fenceMatch[2]!.includes('`')) fence = { char, length: marker.length };
      } else if (fence.char === char && marker.length >= fence.length && fenceMatch[2]!.trim() === '') {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (headingMatch === null) continue;
    const level = headingMatch[1]!.length;
    const title = stripOptionalClosingHashes(headingMatch[2] ?? '');

    if (startLine === -1) {
      if (title === normalizedTarget && (requiredLevel === null || level === requiredLevel)) {
        startLine = i;
        startLevel = level;
      }
    } else {
      const stop = options.includeSubheadings === false ? true : level <= startLevel;
      if (stop) {
        endLine = i;
        break;
      }
    }
  }

  if (startLine === -1) return null;
  const sectionText = `${lines.slice(startLine, endLine).join('\n').trimEnd()}\n`;
  return finalizeExtractedSection(sectionText, sourceSha256, maxBytes);
}

function resolveJsonPointerValue(root: Json, segments: readonly string[]): { readonly found: true; readonly value: Json } | { readonly found: false } {
  let current: Json = root;
  for (const seg of segments) {
    if (FORBIDDEN_PROTOTYPE_SEGMENTS.has(seg)) return { found: false };
    if (Array.isArray(current)) {
      if (!NON_NEGATIVE_ARRAY_INDEX_PATTERN.test(seg)) return { found: false };
      const idx = Number(seg);
      if (!Number.isSafeInteger(idx) || idx < 0 || idx >= current.length) return { found: false };
      current = current[idx]!;
    } else if (current !== null && typeof current === 'object') {
      if (!Object.hasOwn(current, seg)) return { found: false };
      current = (current as Record<string, Json>)[seg]!;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

/**
 * Deterministic RFC 6901 JSON Pointer extractor rendering matched values as JCS canonical JSON.
 */
export function extractJsonPointerSection(
  rawUtf8: Uint8Array,
  pointers: readonly string[],
  options: { readonly maxBytes: number },
): ExtractedSection | null {
  const maxBytes = validateMaxBytesOption(options.maxBytes);
  if (!Array.isArray(pointers) || pointers.length < 1 || pointers.length > LIMITS.handoffPointers) {
    refuse('CONFIG_SCHEMA', '/pointers');
  }
  const decodedList = pointers.map((ptr, idx) => ({
    pointer: ptr,
    segments: decodeJsonPointer(ptr, `/pointers/${idx}`),
  }));
  const seenPointers = new Set<string>();
  for (const item of decodedList) {
    if (seenPointers.has(item.pointer)) refuse('CONFIG_SCHEMA', '/pointers');
    seenPointers.add(item.pointer);
  }

  const view = ownUtf8View(rawUtf8, '/source', 'execution');
  const sourceSha256 = createHash('sha256').update(view).digest('hex');
  let parsed: Json;
  try {
    parsed = parsePrivateJson(view, LIMITS.handoffSourceBytes, CONTROLLER_LIMITS.handoffJsonCollectionLimit);
  } catch {
    refuse('ARTIFACT_INVALID', '/source', 'execution');
  }

  const matched = Object.create(null) as Record<string, Json>;
  for (const { pointer, segments } of decodedList) {
    const found = resolveJsonPointerValue(parsed, segments);
    if (!found.found) return null;
    matched[pointer] = found.value;
  }
  const rendered = `${canonical(matched)}\n`;
  return finalizeExtractedSection(rendered, sourceSha256, maxBytes);
}

/**
 * Bounded UTF-8 `full` slice extractor preserving multi-byte character boundaries and SHA-256 provenance.
 */
export function extractFullSection(
  rawUtf8: Uint8Array,
  options: { readonly maxBytes: number },
): ExtractedSection {
  const maxBytes = validateMaxBytesOption(options.maxBytes);
  const view = ownUtf8View(rawUtf8, '/source', 'execution');
  const sourceSha256 = createHash('sha256').update(view).digest('hex');
  decodeUtf8Strict(view, '/source', 'execution');
  if (view.byteLength <= maxBytes) {
    return Object.freeze({
      content: Buffer.from(view).toString('utf8'),
      sourceSha256,
      extractSha256: sourceSha256,
      byteLength: view.byteLength,
      truncated: false,
    });
  }
  let cut = maxBytes;
  while (cut > 0 && (view[cut]! & 0xc0) === 0x80) cut -= 1;
  const sliced = view.subarray(0, cut);
  return Object.freeze({
    content: Buffer.from(sliced).toString('utf8'),
    sourceSha256,
    extractSha256: createHash('sha256').update(sliced).digest('hex'),
    byteLength: sliced.byteLength,
    truncated: true,
  });
}

function normalizeSourceCopy(source: StepHandoffSource): StepHandoffSource {
  return source.kind === 'artifact'
    ? { kind: 'artifact', path: source.path }
    : { kind: source.kind };
}

function normalizeSelectCopy(select: StepHandoffSelect): StepHandoffSelect {
  if (select.kind === 'markdown_heading') {
    return {
      kind: 'markdown_heading',
      heading: select.heading,
      ...(select.includeSubheadings !== undefined ? { includeSubheadings: select.includeSubheadings } : {}),
    };
  }
  if (select.kind === 'json_pointer') {
    return { kind: 'json_pointer', pointers: [...select.pointers] };
  }
  return { kind: 'full' };
}

function unwrapOptionalFencedJsonBytes(rawBytes: Uint8Array): Uint8Array {
  const text = decodeUtf8Strict(rawBytes, '/source', 'execution').trim();
  if (!text.startsWith('```')) return rawBytes;
  const match = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(text);
  if (!match) return rawBytes;
  return new Uint8Array(Buffer.from(match[1]!, 'utf8'));
}

/**
 * Evaluate a step's declared `handoffs` deterministically against upstream snapshots/submissions/verdicts,
 * enforcing per-selector and per-step aggregate caps and `required` vs `required: false` provenance.
 */
export function evaluateStepHandoffSelectors(
  selectors: readonly StepHandoffSelector[],
  resolveSource: (selector: StepHandoffSelector, index: number) => UpstreamSourceLookupResult,
  options?: { readonly stepIndex?: number; readonly reworkEpoch?: number },
): readonly ResolvedSelectorExtract[] {
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > LIMITS.handoffsPerStep) {
    refuse('CONFIG_SCHEMA', '/spec/task/spec/steps', 'execution');
  }
  const stepBasePath = options?.stepIndex !== undefined
    ? `/spec/task/spec/steps/${options.stepIndex}/handoffs`
    : '/handoffs';
  let configuredAggregateBytes = 0;
  let extractedAggregateBytes = 0;
  const seenIds = new Set<string>();
  const resolved: ResolvedSelectorExtract[] = [];

  for (let index = 0; index < selectors.length; index += 1) {
    const selector = selectors[index]!;
    const selPath = `${stepBasePath}/${index}`;
    const selectorId = selector.id ?? `handoff-${index + 1}`;
    if (seenIds.has(selectorId)) refuse('CONFIG_SCHEMA', `${selPath}/id`, 'execution');
    seenIds.add(selectorId);

    const maxBytes = validateMaxBytesOption(
      selector.maxBytes ?? LIMITS.handoffDefaultBytes,
      `${selPath}/maxBytes`,
    );
    configuredAggregateBytes += maxBytes;
    if (configuredAggregateBytes > LIMITS.handoffAggregateBytes) {
      refuse('OUTPUT_LIMIT', selPath, 'execution');
    }

    const required = selector.required !== false;
    const sourceCopy = normalizeSourceCopy(selector.source);
    const selectCopy = normalizeSelectCopy(selector.select);
    const lookup = resolveSource(selector, index);
    const effectiveEpoch = lookup.reworkEpoch ?? options?.reworkEpoch ?? 0;

    if (!lookup.found || lookup.bytes === null) {
      if (required) {
        const missingPath = selector.source.kind === 'artifact' ? `${selPath}/source/path` : `${selPath}/source`;
        refuse('EVIDENCE_UNAVAILABLE', missingPath, 'execution');
      }
      resolved.push(
        freeze({
          provenance: {
            id: selectorId,
            fromStep: selector.fromStep,
            fromAttemptId: lookup.fromAttemptId,
            reworkEpoch: effectiveEpoch,
            source: sourceCopy,
            select: selectCopy,
            status: 'omitted',
            sourceSha256: null,
            extractSha256: null,
            byteLength: 0,
            truncated: false,
            omittedReason: 'source_missing',
          },
          content: null,
        }),
      );
      continue;
    }

    const rawView = ownUtf8View(lookup.bytes, `${selPath}/source`, 'execution');
    const rawSourceSha256 = createHash('sha256').update(rawView).digest('hex');

    let extracted: ExtractedSection | null;
    let missingReason: HandoffOmittedReason = 'source_missing';
    try {
      if (selector.select.kind === 'markdown_heading') {
        missingReason = 'heading_missing';
        extracted = extractMarkdownHeadingSection(rawView, selector.select.heading, {
          ...(selector.select.includeSubheadings !== undefined ? { includeSubheadings: selector.select.includeSubheadings } : {}),
          maxBytes,
        });
      } else if (selector.select.kind === 'json_pointer') {
        missingReason = 'pointer_missing';
        const jsonInput = selector.source.kind === 'artifact' ? rawView : unwrapOptionalFencedJsonBytes(rawView);
        const rawExtracted = extractJsonPointerSection(jsonInput, selector.select.pointers, { maxBytes });
        extracted = rawExtracted === null ? null : Object.freeze({ ...rawExtracted, sourceSha256: rawSourceSha256 });
      } else {
        extracted = extractFullSection(rawView, { maxBytes });
      }
    } catch (error) {
      if (error instanceof ControllerFailure) {
        refuse(error.diagnostic.code, `${selPath}${error.diagnostic.path}`, 'execution');
      }
      refuse('ARTIFACT_INVALID', `${selPath}/source`, 'execution');
    }

    if (extracted === null) {
      if (required) {
        const missingSelectPath = selector.select.kind === 'markdown_heading'
          ? `${selPath}/select/heading`
          : `${selPath}/select/pointers`;
        refuse('EVIDENCE_UNAVAILABLE', missingSelectPath, 'execution');
      }
      resolved.push(
        freeze({
          provenance: {
            id: selectorId,
            fromStep: selector.fromStep,
            fromAttemptId: lookup.fromAttemptId,
            reworkEpoch: effectiveEpoch,
            source: sourceCopy,
            select: selectCopy,
            status: 'omitted',
            sourceSha256: rawSourceSha256,
            extractSha256: null,
            byteLength: 0,
            truncated: false,
            omittedReason: missingReason,
          },
          content: null,
        }),
      );
      continue;
    }

    extractedAggregateBytes += extracted.byteLength;
    if (extractedAggregateBytes > LIMITS.handoffAggregateBytes) {
      refuse('OUTPUT_LIMIT', selPath, 'execution');
    }

    resolved.push(
      freeze({
        provenance: {
          id: selectorId,
          fromStep: selector.fromStep,
          fromAttemptId: lookup.fromAttemptId,
          reworkEpoch: effectiveEpoch,
          source: sourceCopy,
          select: selectCopy,
          status: 'extracted',
          sourceSha256: extracted.sourceSha256,
          extractSha256: extracted.extractSha256,
          byteLength: extracted.byteLength,
          truncated: extracted.truncated,
        },
        content: extracted.content,
      }),
    );
  }

  return freeze(resolved);
}

function handoffLogicalPath(index: number, provenance: HandoffProvenance): string {
  const ext = provenance.select.kind === 'markdown_heading'
    ? 'md'
    : provenance.select.kind === 'json_pointer'
      ? 'json'
      : 'txt';
  return `handoffs/${String(index).padStart(2, '0')}-${provenance.id}.${ext}`;
}

/**
 * Scrub every extracted handoff via `vault.assertClean` and `SecretScrubber`, then persist to CAS.
 */
export async function persistHandoffExtractsToCas(
  resolved: readonly ResolvedSelectorExtract[],
  artifacts: ArtifactStore,
  scrubber: Pick<SecretScrubber, 'containsSecret'> = DEFAULT_HANDOFF_SCRUBBER,
): Promise<readonly AttemptHandoffExtract[]> {
  const persisted: AttemptHandoffExtract[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    const item = resolved[index]!;
    if (item.provenance.status === 'omitted' || item.content === null) {
      persisted.push(freeze({ ...item.provenance, artifact: null }));
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(item.content, 'utf8'));
    artifacts.vault.assertClean(bytes);
    if (scrubber.containsSecret(item.content)) {
      refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials', 'execution');
    }
    const logicalName = handoffLogicalPath(index, item.provenance);
    const casPointer = await artifacts.putCasBlobFromBytes(logicalName, bytes, LIMITS.handoffMaxBytes);
    if (casPointer.sha256 !== item.provenance.extractSha256 || casPointer.byteLength !== item.provenance.byteLength) {
      refuse('ARTIFACT_INVALID', logicalName, 'execution');
    }
    persisted.push(freeze({ ...item.provenance, artifact: casPointer.blobRef }));
  }
  return freeze(persisted);
}

function describeSourceLabel(source: StepHandoffSource): string {
  return source.kind === 'artifact' ? `artifact:${source.path}` : source.kind;
}

function describeSelectLabel(select: StepHandoffSelect): string {
  if (select.kind === 'markdown_heading') return `markdown_heading(${JSON.stringify(select.heading)})`;
  if (select.kind === 'json_pointer') return `json_pointer(${select.pointers.join(',')})`;
  return 'full';
}

/**
 * Append a deterministic, UTF-8/UTF-16-bounded handoff summary block to `basePrompt`,
 * failing closed with `OUTPUT_LIMIT` if the appendix exceeds `maxPromptBytes`.
 */
export function appendHandoffPromptBlock(
  basePrompt: string,
  resolved: readonly ResolvedSelectorExtract[],
  maxPromptBytes: number,
  phase: ControllerDiagnostic['phase'] = 'execution',
): string {
  if (resolved.length === 0) return basePrompt;
  const effectiveMax = Math.min(maxPromptBytes, LIMITS.inputBytes);
  const sections: string[] = [];
  for (const item of resolved) {
    const { provenance, content } = item;
    const srcLabel = describeSourceLabel(provenance.source);
    if (provenance.status === 'omitted' || content === null) {
      sections.push(
        `--- Handoff [${provenance.id}] from step "${provenance.fromStep}" (${srcLabel}, status=omitted, reason=${provenance.omittedReason ?? 'source_missing'}) ---`,
      );
      continue;
    }
    const selLabel = describeSelectLabel(provenance.select);
    const truncTag = provenance.truncated ? ', truncated=true' : '';
    const trimmedBody = content.endsWith('\n') ? content.slice(0, -1) : content;
    sections.push(
      `--- Handoff [${provenance.id}] from step "${provenance.fromStep}" (${srcLabel}, select=${selLabel}, sha256=${provenance.extractSha256}${truncTag}) ---\n${trimmedBody}`,
    );
  }
  const appendix = `\n\nUpstream Step Handoffs:\n${sections.join('\n')}`;
  const full = basePrompt + appendix;
  if (effectiveMax < 1 || full.length > effectiveMax || Buffer.byteLength(full, 'utf8') > effectiveMax) {
    refuse('OUTPUT_LIMIT', '/handoffs', phase);
  }
  return full;
}

/**
 * Materialize active resources and CAS-backed handoff extracts as `0o400` read-only files in `contextDir`,
 * enforcing `<= 64` total `contextFiles`.
 */
export async function materializeContextFilesDir(
  contextDir: string,
  activeResources: readonly { readonly ref: ArtifactRef; readonly bytes: Uint8Array }[],
  handoffExtracts: readonly AttemptHandoffExtract[],
  artifactsDirectory: string,
  phase: ControllerDiagnostic['phase'] = 'execution',
): Promise<readonly string[]> {
  const presentHandoffs = handoffExtracts.filter(
    (item): item is AttemptHandoffExtract & { readonly artifact: ArtifactRef; readonly extractSha256: string } =>
      item.status === 'extracted' && item.artifact !== null && item.extractSha256 !== null,
  );
  if (activeResources.length + presentHandoffs.length > CONTROLLER_LIMITS.maxStepContextFiles) {
    refuse('OUTPUT_LIMIT', '/handoffs', phase);
  }

  const contextFiles: string[] = [];
  for (const resource of activeResources) {
    const targetPath = join(contextDir, resource.ref.name);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const file = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try {
      await file.writeFile(resource.bytes);
      await file.chmod(0o400);
      await file.sync();
    } finally {
      await file.close();
    }
    contextFiles.push(targetPath);
  }

  for (const handoff of presentHandoffs) {
    const canonicalBlobPath = await resolveCanonicalCasBlobPath(artifactsDirectory, handoff.extractSha256, undefined, phase);
    const targetPath = join(contextDir, handoff.artifact.name);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await copyVerifiedFileReadOnly(canonicalBlobPath, targetPath, {
      expectedBytes: handoff.byteLength,
      expectedSha256: handoff.extractSha256,
      mode: 0o400,
      ownedSource: true,
      requireReadOnlySource: true,
      verifyCanonicalSource: true,
      path: handoff.artifact.name,
      phase,
    });
    contextFiles.push(targetPath);
  }

  return freeze(contextFiles);
}
