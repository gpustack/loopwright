import { constants } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { stringify } from 'yaml';
export async function canonicalPath(path: string): Promise<void> {
  let current = resolve(path); for (;;) { if ((await lstat(current)).isSymbolicLink()) throw new Error('CLI_PATH'); const parent = dirname(current); if (parent === current) break; current = parent; }
}
export async function writeOutput(path: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1048576) throw new Error('CLI_OUTPUT_LIMIT'); await canonicalPath(dirname(resolve(path)));
  const file = await open(resolve(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function appendStepSummary(path: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1048576) throw new Error('CLI_OUTPUT_LIMIT');
  const resolved = resolve(path);
  await canonicalPath(dirname(resolved));
  const file = await open(
    resolved,
    constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('CLI_PATH');
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function initDraft(path: string, force: boolean) {
  const directory = resolve(path); await canonicalPath(dirname(directory));
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await canonicalPath(directory); const parent = await lstat(directory); if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o077) throw new Error('CLI_PATH');
  const registry = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'TrustedRegistry', metadata: { name: 'operator-draft' }, spec: { version: 1, resourceVersion: 'context-draft', handlers: [], roleProfiles: [], runtimeProfiles: [], resources: [], credentialBindings: [], environmentBindings: [] } };
  const registryBytes = Buffer.from(stringify(registry, { indent: 2, schema: 'core', lineWidth: 0 }), 'utf8'), digest = createHash('sha256').update(registryBytes).digest('hex');
  const task = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract', spec: {
    goal: 'Replace this draft with an explicit task and approved operator bindings.', taskpack: 'local', target: { repository: 'team/repository', baseRevision: 'REVIEW_REQUIRED', sourceRevision: 'REVIEW_REQUIRED', matrix: null },
    scope: { writable: ['result.json'], protected: [] }, roles: [{ id: 'builder', adapter: 'pi', provider: 'zai', model: 'REVIEW_REQUIRED', thinking: 'high', tools: ['read'] }],
    trustedContext: { revision: 'context-draft', discovery: 'disabled', resources: [] }, budgets: { wallTimeMs: 600000, totalTokens: 32768, perCallOutputTokens: 1024, maxModelCalls: 8, maxConcurrency: 1, maxFormatRepairs: 0, maxImplementationRepairs: 0, maxTransportRetries: 1,
      enforcement: { wallTime: 'hard_admission', tokens: 'soft_accounting', modelCalls: 'hard_admission', concurrency: 'hard_admission', formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission' } },
    steps: [{ id: 'build', kind: 'agent', uses: 'REVIEW_REQUIRED', roleId: 'builder', dependsOn: [] }], acceptance: { required: ['tests'], checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }] } } };
  const config = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ControllerConfig', spec: { task, registry: { name: 'operator-draft', digest: { algorithm: 'sha256', hex: digest } }, profiles: { roles: [{ roleId: 'builder', profileRef: 'REVIEW_REQUIRED' }], steps: [{ stepId: 'build', handlerRef: 'REVIEW_REQUIRED' }] }, credentials: [], controls: { maxAttempts: 8, drainReserveMs: 120000, repeatFailureLimit: 2, submission: { mode: 'artifact_or_assistant', path: null } } } };
  const files = new Map<string, Uint8Array>([['controller.draft.yaml', Buffer.from(stringify(config, { indent: 2, schema: 'core', lineWidth: 0 }), 'utf8')], ['registry.draft.yaml', registryBytes], ['README.draft.md', Buffer.from('Execution readiness: unsupported (draft).\nContext mode: proven_bound (strict default); live proven bound unavailable.\nDraft files: controller.draft.yaml and registry.draft.yaml.\nNo credentials, approved runtime, handlers or resources are installed.\nApprove registry bytes outside the repository and working directory; pass explicit absolute paths and SHA256.\nReplace REVIEW_REQUIRED values and supply the exact installed identities.\nAny estimated_guard context requires explicit immutable operator opt-in.\n')]]);
  const originals = new Map<string, Awaited<ReturnType<typeof lstat>>>();
  for (const name of files.keys()) {
    try { const info = await lstat(join(directory, name)); if (!force || !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error('CLI_OVERWRITE'); originals.set(name, info); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  for (const [name, bytes] of files) {
    const original = originals.get(name), target = join(directory, name);
    if (!original) await writeOutput(target, bytes);
    else {
      const currentParent = await lstat(directory), current = await lstat(target); if (currentParent.ino !== parent.ino || currentParent.dev !== parent.dev || current.ino !== original.ino || current.dev !== original.dev || current.size !== original.size || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs) throw new Error('CLI_PATH');
      const temporary = join(directory, '.' + name + '.' + randomBytes(16).toString('hex')); await writeOutput(temporary, bytes); await rename(temporary, target);
    }
  }
  const held = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { await held.sync(); } finally { await held.close(); }
  return { version: 1, readiness: 'unsupported', contextMode: 'proven_bound', files: [...files.keys()] };
}
