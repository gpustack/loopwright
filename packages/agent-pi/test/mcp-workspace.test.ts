import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, link, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWorkspace } from '../src/workspace-mcp.js';
test('workspace MCP reads only bounded regular files in its candidate root', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-mcp-')), root = join(directory, 'candidate'); await mkdir(root);
  try {
    await writeFile(join(root, 'allowed.txt'), 'ALLOWED'); await writeFile(join(directory, 'outside'), 'SYNTHETIC_OUTSIDE');
    assert.equal(await readWorkspace(root, 'allowed.txt', 32), 'ALLOWED');
    await assert.rejects(readWorkspace(root, '../outside', 32));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('workspace MCP rejects linked files and oversized output before returning data', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-mcp-')), root = join(directory, 'candidate'); await mkdir(root);
  try {
    await writeFile(join(directory, 'outside'), 'SYNTHETIC_OUTSIDE'); await symlink(join(directory, 'outside'), join(root, 'linked'));
    await assert.rejects(readWorkspace(root, 'linked', 64));
    await link(join(directory, 'outside'), join(root, 'hard')); await assert.rejects(readWorkspace(root, 'hard', 64));
    await writeFile(join(root, 'large'), 'X'.repeat(1024)); await assert.rejects(readWorkspace(root, 'large', 32));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
