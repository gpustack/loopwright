import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frozenLoader, systemPrompt } from '../src/resources.js';
import { prepareInput } from '../src/preflight.js';
import { sessionInput } from './session-fixtures.js';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
test('literal loader has no discovery, append, skill, prompt or theme authority', async () => {
  const prompt = systemPrompt(prepareInput(sessionInput()));
  const extensions = { extensions: [], errors: [], runtime: {} } as unknown as ReturnType<ResourceLoader['getExtensions']>;
  const loader = frozenLoader(prompt, extensions);
  assert.deepEqual(loader.getAgentsFiles().agentsFiles, []); assert.deepEqual(loader.getAppendSystemPrompt(), []);
  assert.deepEqual(loader.getSkills().skills, []); assert.deepEqual(loader.getPrompts().prompts, []); assert.deepEqual(loader.getThemes().themes, []);
  assert.equal(loader.getSystemPromptSource(), undefined); assert.deepEqual(loader.getAppendSystemPromptSources(), []);
  assert.throws(() => loader.extendResources({ skillPaths: [] })); await loader.reload(); assert.equal(loader.getSystemPrompt(), prompt);
});
test('final loader reload refuses changed native snapshot without rediscovery', async () => {
  const extensions = { extensions: [], errors: [], runtime: {} } as unknown as ReturnType<ResourceLoader['getExtensions']>;
  const loader = frozenLoader('literal', extensions);
  await loader.reload(); assert.equal(loader.getExtensions(), extensions);
  extensions.errors.push({ path: '<inline:unexpected>', error: 'changed after bootstrap' });
  await assert.rejects(loader.reload(), /snapshot/);
});
