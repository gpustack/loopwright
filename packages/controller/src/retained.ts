import { join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { validateDocument } from '@loopwright/core';
import type { LocalRunIdentity } from '@loopwright/state';
import { readBoundedFile, canonicalComponents } from './files.js';
import { checkedRef, readArtifact, type ArtifactReader } from './storage.js';
import { parsePrivateJson } from './parser.js';
import { id, record, same, text } from './schema.js';
import { refuse } from './errors.js';
import type { RunDescriptor } from './controller.js';
import type { CompiledPlan } from './types.js';
export interface RetainedRunInput { readonly runRoot: string; readonly runId: string }
/** Read only: never mkdir, claim, discover configuration, inspect Docker or resolve credentials. */
export async function readRetained(input: RetainedRunInput) {
  const root = resolve(text(input.runRoot)), runId = id(input.runId), directory = join(root, runId);
  for (const path of [root, directory, join(directory, 'artifacts')]) {
    await canonicalComponents(path); const info = await lstat(path);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) refuse('ARTIFACT_INVALID', '', 'recovery');
  }
  const raw = record(parsePrivateJson(await readBoundedFile(join(directory, 'run.json'), 1048576, true), 1048576), ['version', 'identity', 'plan', 'source', 'sourceWorkspace', 'configuration', 'repository']);
  const identity = record(raw.identity, ['directory', 'storeId', 'lock', 'policy', 'binding']), lock = validateDocument(identity.lock, 'TaskLock');
  if (raw.version !== 1 || !lock.ok || lock.value.spec.runId !== runId || identity.directory !== join(directory, 'state')) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const configuration = record(raw.configuration, ['configPath', 'registryPath', 'registrySha256']);
  text(configuration.configPath); text(configuration.registryPath); if (!/^[a-f0-9]{64}$/.test(text(configuration.registrySha256))) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const descriptor: RunDescriptor = { version: 1, identity: identity as unknown as LocalRunIdentity, plan: checkedRef(raw.plan), source: checkedRef(raw.source), sourceWorkspace: checkedRef(raw.sourceWorkspace),
    configuration: configuration as unknown as RunDescriptor['configuration'], repository: text(raw.repository) };
  const artifacts: ArtifactReader = { read: (ref, maximum) => readArtifact(join(directory, 'artifacts'), ref, maximum) };
  const plan = parsePrivateJson(await artifacts.read(descriptor.plan, 4194304), 4194304) as unknown as CompiledPlan;
  if (plan.version !== 1 || !same(plan.task, lock.value.spec.contract)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return { directory, descriptor, plan, lock: lock.value, artifacts };
}
