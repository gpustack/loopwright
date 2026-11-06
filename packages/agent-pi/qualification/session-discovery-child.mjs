/* global console */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
const directory = await mkdtemp('/tmp/lw-discovery-positive-');
try {
  await writeFile(directory + '/APPEND_SYSTEM.md', 'SYNTHETIC_AMBIENT_APPEND_CANARY');
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory({}), noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload(); assert.ok(loader.getAppendSystemPrompt().join('\n').includes('SYNTHETIC_AMBIENT_APPEND_CANARY'));
  console.log(JSON.stringify({ actualSdkDiscoveryPositive: true, noContextFilesAloneAdmitsAppendSystem: true, physicalModelSends: 0 }));
} finally { await rm(directory, { recursive: true, force: true }); }
