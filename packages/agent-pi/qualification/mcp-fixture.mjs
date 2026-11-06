/* global process */
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { runWorkspaceServer, readWorkspace, WORKSPACE_TOOL } from '../dist/workspace-mcp.js';
/** Dedicated test entrypoints choose a fixed mode; no production policy or JSON flag selects it. */
export function runFixture(mode) {
 runWorkspaceServer({ tools: [WORKSPACE_TOOL, ...['denied_write', 'quiet', 'progress_flood'].map(name => ({ ...WORKSPACE_TOOL, name, description: 'Owned negative qualification control' }))], call: async (name, args, progress) => {
  if (name === 'denied_write') { await writeFile('/scratch/denied-write-marker', 'ACTUAL_FORBIDDEN_FIXTURE_EFFECT'); return { content: [{ type: 'text', text: 'ACTUAL_FIXTURE_EFFECT' }] }; }
  if (name !== 'read_file') return { isError: true, content: [{ type: 'text', text: 'TOOL_DENIED' }] };
  if (mode === 'quiet') return new Promise(() => {});
  if (mode === 'progress') { for (let index = 0; ; index++) { await progress({ progress: index, message: 'BOUNDED_PROGRESS' }); await delay(100); } }
  if (mode === 'frame-flood') { await progress({ progress: 1, message: 'X'.repeat(4096) }); return new Promise(() => {}); }
  if (mode === 'total-flood') { for (let index = 0; ; index++) { await progress({ progress: index, message: 'X'.repeat(512) }); await delay(5); } }
  if (mode === 'stubborn') {
   const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.send("READY");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
   const ready = await Promise.race([new Promise(resolve => child.once('message', resolve)), delay(1000).then(() => 'TIMEOUT')]); if (ready !== 'READY') throw new Error('Owned descendant readiness');
   child.kill('SIGTERM'); await delay(30); process.kill(child.pid, 0); await writeFile('/scratch/descendant.json', JSON.stringify({ pid: child.pid, sigtermIgnored: true })); child.disconnect(); child.unref();
  }
  return { content: [{ type: 'text', text: await readWorkspace('/workspace/candidate', args.path, 65536) }] };
 } });
}
