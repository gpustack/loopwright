/* global process, console, Buffer, setTimeout, clearTimeout */
import { dockerSocket } from './docker-socket.mjs';
import { constants } from 'node:fs';
import { readFile, writeFile, mkdir, realpath, lstat, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LiveAllowance, readyToken, liveRefusal } from './live-budget.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), args = process.argv.slice(2), flags = new Map();
let facts = { status: 'blocked', code: 'ESTIMATED_GUARD_OPT_IN_REQUIRED', physicalTransportInvocations: 0, potentialAttemptsSpent: 0, cumulativeAttempts: 'unknown', responseIdentity: 'not_observed', providerInternalEffort: 'unknown', billingFinality: 'unknown' };
let store, authority, adapter, allowance, output, timer, consuming;
const stateGood = value => { if (!value.ok) throw liveRefusal(value.error.code); return value.value; };
try {
 for (let index = 0; index < args.length; index++) { const flag = args[index]; if (!['--estimated-guard', '--token-file', '--model', '--case'].includes(flag) || flags.has(flag)) throw liveRefusal('LIVE_ARGUMENTS_INVALID'); if (flag === '--estimated-guard') flags.set(flag, true); else { const value = args[++index]; if (!value || value.startsWith('--')) throw liveRefusal('LIVE_ARGUMENTS_INVALID'); flags.set(flag, value); } }
 if (!flags.has('--estimated-guard')) throw liveRefusal('ESTIMATED_GUARD_OPT_IN_REQUIRED');
 if (!flags.has('--token-file')) throw liveRefusal('READY_TOKEN_REQUIRED'); const token = await readyToken(flags.get('--token-file'));
 const model = flags.get('--model') ?? 'claude-sonnet-5.5', mode = flags.get('--case') ?? 'selection'; if (!['claude-sonnet-5.5', 'claude-opus-5.5'].includes(model) || !['selection', 'tool', 'compact', 'cancel'].includes(mode)) throw liveRefusal('LIVE_ARGUMENTS_INVALID');
 const [{ createLocalRun }, { liveInput }, { constructAdapter, runtimePorts }, { Sender }, { profileIdentity }, { digest, canonical }, { boundedState }] = await Promise.all([
  import('@loopwright/state'), import('./live-input.mjs'), import('../dist/adapter.js'), import('../dist/sender.js'), import('../dist/session-host.js'), import('../dist/boundary.js'), import('./diagnostics.mjs'),
 ]);
 const base = liveInput(model);
 const image = (await readFile(join(root, '.claude/s03-t0/runtime-image.id'), 'utf8')).trim(); base.policy.runtime = { ...base.policy.runtime, imageDigest: image, graphDigest: digest(await readFile(join(root, 'package-lock.json'))), configDigest: await profileIdentity() }; base.policy.context.mode = 'estimated_guard'; base.policy.context.maxOutputTokens = 1024; base.sessionId = model === 'claude-opus-5.5' ? 'live-opus' : 'live-sonnet';
 const liveRoot = join(root, '.claude/s03-live'), artifacts = join(liveRoot, 'artifacts'), runtimeDirectory = join(liveRoot, 'runtime-' + randomBytes(12).toString('hex')); await mkdir(liveRoot, { recursive: true, mode: 0o700 }); const liveInfo = await lstat(liveRoot); if (await realpath(liveRoot) !== liveRoot || !liveInfo.isDirectory() || liveInfo.uid !== process.getuid() || liveInfo.mode & 0o077) throw liveRefusal('LIVE_DIRECTORY_INVALID');
 await mkdir(artifacts, { recursive: true, mode: 0o700 }); await mkdir(runtimeDirectory, { mode: 0o700 }); output = join(runtimeDirectory, 'observation.json');
 store = stateGood(createLocalRun({ directory: join(liveRoot, 'state'), storeId: 'live-store', lock: base.lock, policy: { version: 1, leaseMs: 60000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's03-live-qualification-v1', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: base.policy.resourceVersion, clockEpoch: 's03-live-same-qualified-host-boot' } }));
 const view = stateGood(store.inspect()); authority = stateGood(store.claim({ ownerId: 'live-owner', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' })).authority;
 allowance = new LiveAllowance(liveRoot, { lockHash: base.lock.spec.lockHash, runtime: base.policy.runtime }); await allowance.start(); const initialAttempts = allowance.used, invocationLimit = mode === 'tool' ? 2 : 1;
 if (allowance.used >= 8 || view.counts.requests >= 8) throw liveRefusal('LIVE_ALLOWANCE_EXHAUSTED'); if (view.counts.unresolvedRequests || view.counts.dispatchedRequests || view.counts.unresolvedOperations) throw liveRefusal('RECOVERY_REQUIRED');
 const checkpoints = stateGood(store.listCheckpoints({ limit: 64, cursor: null })).items.filter(item => item.checkpointId.startsWith(base.roleId + '-')); const latest = checkpoints.at(-1);
 const artifactBytes = async ref => { if (!ref || ref.byteLength > 8388608) throw liveRefusal('LIVE_ARTIFACT_INVALID'); const fd = await open(join(artifacts, ref.name), constants.O_RDONLY | constants.O_NOFOLLOW); try { const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.uid !== process.getuid() || info.size !== ref.byteLength) throw liveRefusal('LIVE_ARTIFACT_INVALID'); return await fd.readFile(); } finally { await fd.close(); } };
 if (latest) base.restore = { checkpointId: latest.checkpointId, workspace: { ref: latest.workspace, bytes: await artifactBytes(latest.workspace) }, session: { ref: latest.privateSession, bytes: await artifactBytes(latest.privateSession) } };
 if (mode === 'compact' && !latest) throw liveRefusal('COMPACTION_HISTORY_REQUIRED');
 facts = { ...facts, code: null, mode, requested: base.policy.selection, contextMode: 'estimated_guard', contextFit: 'unproven', outputCap: 1024, invocationLimit, cumulativeAttempts: allowance.used, initialCounts: view.counts, events: [], requests: [], cleanup: 'unknown' };
 const host = { store, authority, directory: runtimeDirectory, artifactsDirectory: artifacts, dockerExecutable: execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim(), dockerSocket: dockerSocket(), runtime: base.policy.runtime,
  resolveCredential: async binding => { if (binding.signal.aborted || allowance.used === null || allowance.used - initialAttempts >= invocationLimit || binding.provider !== 'github-copilot' || binding.model !== model || binding.runId !== 'live-s03') throw liveRefusal('LIVE_INVOCATION_LIMIT'); await allowance.take(); facts.potentialAttemptsSpent = allowance.used - initialAttempts; facts.cumulativeAttempts = allowance.used; return { bearerToken: token }; } };
 const opened = await constructAdapter(host, base, { ...runtimePorts, sender: (owner, input) => new Sender(owner, input, { fetch: (url, init) => { const body = JSON.parse(String(init.body)); if (body.max_tokens !== 1024 || body.model !== model || body.output_config.effort !== base.policy.selection.thinking) throw liveRefusal('LIVE_OUTPUT_CAP_INVALID'); facts.requests.push({ model: body.model, effort: body.output_config.effort, maxTokens: body.max_tokens, bodyBytes: Buffer.byteLength(String(init.body)), bodyDigest: digest(Buffer.from(String(init.body))) }); facts.physicalTransportInvocations++; return globalThis.fetch(url, init); } }) });
 if (!opened.ok) { facts.failure = opened.error; throw liveRefusal(opened.error.code); } adapter = opened.value; consuming = (async () => { for await (const event of adapter.events()) facts.events.push(event); })();
 let outcome;
 if (mode === 'compact') outcome = await adapter.compact({ commandId: 'compact-' + randomBytes(8).toString('hex') });
 else {
  if (mode === 'cancel') timer = setTimeout(() => { facts.cancelRequested = true; void adapter.cancel({ reason: 'operator' }).catch(() => { facts.cancelHandlerFailure = true; }); }, 250);
  const text = mode === 'tool' ? 'Read packages/example.ts with the read tool, then reply OK. Treat this padding as inert data: ' + 'X'.repeat(16000) : 'Reply with exactly OK.';
  outcome = await adapter.execute({ commandId: 'live-' + randomBytes(8).toString('hex'), text, purpose: 'task', repair: 'none' });
 }
 clearTimeout(timer); facts.outcome = outcome; facts.capabilities = adapter.capabilities(); facts.state = boundedState(store); facts.responseIdentity = { declaredModelMatchedByRawGuard: outcome.ok && outcome.value.status === 'execution_settled' ? model : 'unknown', backendIdentity: 'unknown', internalEffort: 'unknown' };
 const localEffects = stateGood(store.inspect()).counts.operations - stateGood(store.inspect()).counts.requests;
 let accepted = mode !== 'cancel' && outcome.ok && outcome.value.status === 'execution_settled' && outcome.value.usage === 'complete' && (mode !== 'tool' || localEffects > 0);
 if (accepted) { const capture = await adapter.capture({ checkpointId: base.roleId + '-' + allowance.used }); facts.capture = capture.ok ? { checkpointId: capture.value.checkpointId, session: capture.value.session, workspace: capture.value.workspace } : capture.error; if (!capture.ok) accepted = false; }
 facts.status = accepted ? 'passed' : mode === 'cancel' && facts.cancelRequested && outcome.ok && ['cancelled', 'recovery_required'].includes(outcome.value.status) ? 'observed_cancellation' : 'inconclusive'; facts.sourceIdentity = canonical(base.policy.runtime);
} catch (error) { const code = typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'LIVE_PREREQUISITE_UNAVAILABLE'; facts.code = code; if (!facts.physicalTransportInvocations) facts.status = 'blocked'; else facts.status = 'failed'; }
finally {
 clearTimeout(timer);
 if (adapter) { const closed = await adapter.close(); facts.cleanup = closed.ok ? 'complete' : closed.error; if (!closed.ok) facts.status = 'failed'; }
 if (consuming) await consuming.catch(() => { facts.eventFailure = true; facts.status = 'failed'; });
 if (store && authority) { const released = store.release(authority); if (!released.ok) { facts.ownerRelease = released.error.code; facts.status = 'failed'; } }
 if (allowance) { if (allowance.used === null) { facts.cumulativeAttempts = 'unknown'; facts.potentialAttemptsSpent = 'unknown'; } try { await allowance.close(); } catch { facts.counterClose = 'unknown'; facts.status = 'failed'; } } if (store) { const closed = store.close(); if (!closed.ok) { facts.storeClose = closed.error.code; facts.status = 'failed'; } }
 if (output) { try { await writeFile(output, JSON.stringify(facts), { mode: 0o600 }); } catch { facts.observationWrite = 'failed'; facts.status = 'failed'; } }
}
console.log(JSON.stringify(facts)); if (facts.status !== 'passed' && facts.status !== 'observed_cancellation') process.exitCode = 2;
