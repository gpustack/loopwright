import { createHash } from 'node:crypto';
import type { ArtifactManifest } from '@loopwright/core';
import { refuse, type ControllerDiagnostic } from './errors.js';

export function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function gitObjectOid(objectFormat: 'sha1' | 'sha256', type: 'tree' | 'blob', bytes: Uint8Array): string {
  return createHash(objectFormat).update(`${type} ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

export interface ParsedGitTreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseGitTreeEntries(
  treeBytes: Uint8Array,
  oidByteLength: 20 | 32,
  phase: ControllerDiagnostic['phase'] = 'verification',
  code: ControllerDiagnostic['code'] = 'ARTIFACT_INVALID',
): readonly ParsedGitTreeEntry[] {
  const entries: ParsedGitTreeEntry[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  while (offset < treeBytes.byteLength) {
    const space = treeBytes.indexOf(0x20, offset);
    if (space <= offset) refuse(code, '', phase);
    const mode = Buffer.from(treeBytes.buffer, treeBytes.byteOffset + offset, space - offset).toString('ascii');
    if (!/^(?:40000|040000|100644|100755|120000|160000)$/.test(mode)) refuse(code, '', phase);
    const nul = treeBytes.indexOf(0x00, space + 1);
    if (nul <= space + 1 || nul + 1 + oidByteLength > treeBytes.byteLength) refuse(code, '', phase);
    let name: string;
    try {
      name = decoder.decode(treeBytes.subarray(space + 1, nul));
    } catch {
      refuse(code, '', phase);
    }
    if (!name || name.includes('/') || name.includes('\0')) refuse(code, '', phase);
    const oid = Buffer.from(treeBytes.buffer, treeBytes.byteOffset + nul + 1, oidByteLength).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 1 + oidByteLength;
  }
  if (offset !== treeBytes.byteLength) refuse(code, '', phase);
  return entries;
}

export function canonicalizeCandidateManifest(manifest: ArtifactManifest): ArtifactManifest {
  const entries = [...manifest.spec.entries].sort((a, b) => compareUtf16(a.name, b.name));
  if (manifest.spec.baseTree !== undefined) {
    const deleted = [...manifest.spec.deleted].sort(compareUtf16);
    return {
      ...manifest,
      metadata: { id: 'candidate' },
      spec: {
        baseTree: manifest.spec.baseTree,
        entries,
        deleted,
      },
    };
  }
  return {
    ...manifest,
    metadata: { id: 'candidate' },
    spec: { entries },
  };
}
