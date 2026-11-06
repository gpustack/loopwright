/* global console */
import assert from 'node:assert/strict';
import { mkdir, writeFile, access, rm } from 'node:fs/promises';
import { compileTrustedFactories, verifyCompilerOutput } from '../dist/factory-bootstrap.js';
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
const candidate = '/workspace/candidate', poison = '/tmp/non-bootstrap-global';
await mkdir(poison + '/extensions', { recursive: true });
const marker = '/tmp/UNAUTHORIZED_CODE_MARKER';
await writeFile(poison + '/extensions/evil.mjs', `import {writeFileSync} from 'node:fs';writeFileSync('${marker}','executed'); export default ()=>{};`);
await writeFile(poison + '/APPEND_SYSTEM.md', 'POISON_GLOBAL_APPEND');
await writeFile(poison + '/settings.json', JSON.stringify({ packages: ['/tmp/unknown-package'], extensions: ['./extensions/evil.mjs'] }));
let factoryRuns = 0, busCalls = 0, sessionCwd;
const compiled = await compileTrustedFactories([{ name: 'loopwright-authorization', factory: pi => {
  factoryRuns++; pi.events.on('loopwright-binding-probe', () => { busCalls++; });
  pi.on('session_start', (_event, ctx) => { sessionCwd = ctx.cwd; });
} }], 'DECLARED_FROZEN_ROLE_RESOURCE');
const runtime = await ModelRuntime.create({ credentials: { read: async () => ({ type: 'api_key', key: 'non-secret' }), list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
const model = runtime.getModel('github-copilot', 'claude-sonnet-5.5');
const created = await createAgentSession({ cwd: candidate, agentDir: compiled.directory, resourceLoader: compiled.loader, settingsManager: compiled.settings, sessionManager: SessionManager.inMemory(candidate), modelRuntime: runtime, model, thinkingLevel: 'xhigh', tools: [] });
assert.equal(created.extensionsResult, compiled.extensions); const original = compiled.extensions.runtime;
await created.session.bindExtensions({}); assert.equal(sessionCwd, candidate);
for (let i = 0; i < 3; i++) { await compiled.loader.reload(); compiled.eventBus.emit('loopwright-binding-probe', null); }
assert.equal(busCalls, 3); assert.equal(factoryRuns, 1); assert.equal(compiled.loader.getExtensions().runtime, original); original.assertActive();
assert.equal(compiled.loader.getSystemPrompt(), 'DECLARED_FROZEN_ROLE_RESOURCE'); assert.deepEqual(compiled.loader.getAppendSystemPrompt(), []);
await assert.rejects(access(marker));
const saved = compiled.extensions.extensions[0].path; compiled.extensions.extensions[0].path = '<inline:wrong>';
assert.throws(() => verifyCompilerOutput(compiled.loader, ['<inline:loopwright-authorization>'])); compiled.extensions.extensions[0].path = saved;
compiled.extensions.errors.push({ path: saved, error: 'synthetic compiler error' }); await assert.rejects(compiled.loader.reload()); compiled.extensions.errors.pop();
let unexpectedRuns = 0;
await assert.rejects(compileTrustedFactories([{ name: 'wrong', factory: () => { unexpectedRuns++; } }], 'literal')); assert.equal(unexpectedRuns, 0);
// Poison the one active automatic HOME root: startup must fail before any factory can execute.
await mkdir('/tmp/home/.agents/skills', { recursive: true }); await writeFile('/tmp/home/.agents/skills/SKILL.md', 'ACTIVE_HOME_CANARY');
await assert.rejects(compileTrustedFactories([{ name: 'loopwright-authorization', factory: () => { unexpectedRuns++; } }], 'literal')); assert.equal(unexpectedRuns, 0);
await rm('/tmp/home/.agents', { recursive: true });
created.session.dispose();
console.log(JSON.stringify({ passed: true, factoryRuns, busCalls, roleCwd: sessionCwd, runtimeIdentity: true, poisonedCandidateAndGlobalAbsent: true, activeHomePoisonDeniedBeforeFactory: true, unexpectedPathAndErrorsDenied: true, repeatedFinalLoaderReload: 3, physicalSends: 0 }));
