import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, lstatSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunnerTaskpackError, type FrozenCorpusEntry, type FrozenCorpusManifest, type FrozenCorpusVerification } from './types.js';

const MAX_MANIFEST_BYTES = 262144;

/** Locate the vendored corpus next to this module in dist, or under the workspace layout when running compiled tests. */
export function defaultCorpusRoot(): string | null {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    for (const candidate of [join(directory, 'vendor', 'runner-auto-sync'), join(directory, 'packages', 'taskpack-runner', 'vendor', 'runner-auto-sync')]) {
      try { lstatSync(join(candidate, 'manifest.json')); return candidate; }
      catch { /* probe the next ancestor. */ }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Strict typed parse of the committed manifest document; malformed inventory is unavailable, not trusted. */
function parseManifest(bytes: Buffer): FrozenCorpusManifest {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString('utf8')); } catch { throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest.json is not valid JSON', 'manifest.json'); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest.json is not an object', 'manifest.json');
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 || typeof value.sourceRepository !== 'string' || typeof value.sourceRevision !== 'string'
    || !Array.isArray(value.files) || value.files.length === 0) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest.json has invalid header fields', 'manifest.json');
  const seen = new Set<string>();
  const files: FrozenCorpusEntry[] = value.files.map((item): FrozenCorpusEntry => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest entry is not an object', 'manifest.json');
    const entry = item as Record<string, unknown>;
    const path = entry.path, sha256 = entry.sha256, entryBytes = entry.bytes, executable = entry.executable;
    if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.split('/').includes('..')
      || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)
      || typeof entryBytes !== 'number' || !Number.isSafeInteger(entryBytes) || entryBytes < 0
      || typeof executable !== 'boolean') throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest entry has invalid fields', typeof path === 'string' ? path : 'manifest.json');
    if (seen.has(path)) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest lists a path twice', path);
    seen.add(path);
    return { path, sha256, bytes: entryBytes, executable };
  });
  return { version: 1, sourceRepository: value.sourceRepository, sourceRevision: value.sourceRevision, files };
}

function sameDigest(expectedHex: string, observedHex: string): boolean {
  return expectedHex.length === observedHex.length && timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(observedHex, 'hex'));
}

/** Every file, symlink, or directory anywhere under the corpus root must be manifest-listed (or the manifest itself). */
async function scanExtraEntries(root: string, listed: ReadonlySet<string>, allowedDirectories: ReadonlySet<string>): Promise<void> {
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative === '' ? entry.name : relative + '/' + entry.name;
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(path)) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'unlisted directory under the frozen corpus', path);
        await visit(path);
        continue;
      }
      if (entry.name === 'manifest.json' && relative === '') continue;
      if (entry.isSymbolicLink()) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'symlink present under the frozen corpus', path);
      if (!listed.has(path)) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'unlisted file under the frozen corpus', path);
    }
  };
  await visit('');
}

/**
 * Verify the vendored frozen corpus bit-for-bit against its committed manifest before any Python helper runs.
 * With no explicit root, the corpus is located relative to this module and then the workspace layout.
 */
export async function verifyFrozenCorpus(corpusRoot?: string): Promise<FrozenCorpusVerification> {
  const root = corpusRoot !== undefined ? corpusRoot : defaultCorpusRoot();
  if (root === undefined || root === null) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'vendored frozen corpus directory is absent');
  let manifestBytes: Buffer;
  try { manifestBytes = await readFile(join(root, 'manifest.json')); }
  catch { throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest.json cannot be read', 'manifest.json'); }
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'manifest.json exceeds the bounded size', 'manifest.json');
  const manifest = parseManifest(manifestBytes);
  const corpusDigest = createHash('sha256').update(manifestBytes).digest('hex');
  const listed = new Set(manifest.files.map(entry => entry.path));
  const allowedDirectories = new Set<string>();
  for (const entry of manifest.files) {
    const segments = entry.path.split('/');
    for (let depth = 1; depth < segments.length; depth++) allowedDirectories.add(segments.slice(0, depth).join('/'));
  }
  for (const entry of manifest.files) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try { stats = await lstat(join(root, entry.path)); }
    catch { throw new RunnerTaskpackError('CORPUS_TAMPERED', 'manifest-listed file is missing', entry.path); }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'manifest-listed file is a symlink or special file', entry.path);
    if (stats.size !== entry.bytes) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'file byte length differs from the pinned manifest', entry.path);
    const observed = createHash('sha256').update(await readFile(join(root, entry.path))).digest('hex');
    if (!sameDigest(entry.sha256, observed)) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'file digest differs from the pinned manifest', entry.path);
    if (entry.executable && (stats.mode & fsConstants.S_IXUSR) === 0) throw new RunnerTaskpackError('CORPUS_TAMPERED', 'executable bit is missing from a pinned script', entry.path);
  }
  await scanExtraEntries(root, listed, allowedDirectories);
  return { root, manifest, fileCount: manifest.files.length, corpusDigest };
}
