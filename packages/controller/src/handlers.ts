import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedFile } from './files.js';
import { hash, canonical } from './schema.js';
import { refuse } from './errors.js';
import type { Implementation } from './types.js';
/** Installed JavaScript bytes, never a path or digest selected by the task. */
export async function installedHandlerDigests() {
  const roots = [
    ['controller', dirname(fileURLToPath(import.meta.url))],
    ...['core', 'state', 'agent-pi'].map(name => [name, dirname(fileURLToPath(import.meta.resolve('@loopwright/' + name)))]),
  ];
  const inventory: { package: string; path: string; digest: string; byteLength: number }[] = [];
  let total = 0, entriesSeen = 0;
  for (const [label, root] of roots) {
    if (!label || !root) refuse('CAPABILITY_UNSUPPORTED', '', 'compile');
    const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }); entriesSeen += entries.length;
      if (depth > 32 || entriesSeen > 1024) refuse('CONFIG_LIMIT', '', 'compile');
      for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (entry.isSymbolicLink()) refuse('CAPABILITY_UNSUPPORTED', '', 'compile');
        if (entry.isDirectory()) { await visit(join(directory, entry.name), prefix + entry.name + '/', depth + 1); continue; }
        if (!entry.name.endsWith('.js')) continue;
        if (inventory.length >= 256) refuse('CONFIG_LIMIT', '', 'compile');
        const bytes = await readBoundedFile(join(directory, entry.name), 1048576, false); total += bytes.byteLength;
        if (total > 8388608) refuse('CONFIG_LIMIT', '', 'compile');
        inventory.push({ package: label, path: prefix + entry.name, digest: hash(bytes).hex, byteLength: bytes.byteLength });
      }
    };
    await visit(root, '', 1);
  }
  return Object.fromEntries((['pi.agent.v1', 'pi.compact.v1', 'scope.v1', 'json-artifact.v1', 'no-change.v1'] as Implementation[])
    .map(implementation => [implementation, hash('loopwright.dev/controller/handler/v1\0' + canonical({ implementation, inventory }))])) as Record<Implementation, ReturnType<typeof hash>>;
}
