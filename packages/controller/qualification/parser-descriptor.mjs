/* global Buffer, console */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseDocument, isAlias, isMap, isSeq, isScalar } from 'yaml';
import { describePiAdapterFiles } from '@loopwright/agent-pi';

function parsed(source) {
  assert.ok(Buffer.byteLength(source) <= 1048576);
  const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, strict: true, customTags: [] });
  assert.equal(document.errors.length, 0);
  let count = 0;
  function visit(node, depth) {
    assert.ok(++count <= 8192 && depth <= 32);
    if (node === null) return;
    assert.equal(isAlias(node), false);
    assert.equal(node.tag, undefined);
    assert.equal(node.anchor, undefined);
    if (isMap(node)) {
      assert.ok(node.items.length <= 128);
      for (const pair of node.items) {
        assert.ok(isScalar(pair.key) && typeof pair.key.value === 'string' && pair.key.value !== '<<');
        visit(pair.value, depth + 1);
      }
    } else if (isSeq(node)) {
      assert.ok(node.items.length <= 128);
      for (const child of node.items) visit(child, depth + 1);
    } else {
      assert.ok(isScalar(node));
      assert.ok(node.value === null || ['boolean', 'number', 'string'].includes(typeof node.value));
      if (typeof node.value === 'number') assert.ok(Number.isSafeInteger(node.value) && !Object.is(node.value, -0));
      if (typeof node.value === 'string') assert.ok(node.value.length <= 16384);
    }
  }
  visit(document.contents, 1);
  return document.toJS({ maxAliasCount: 0 });
}

assert.deepEqual(parsed('nested:\n  values: ["${MCP_TOKEN}", "$$", "a\\nb"]\n'), { nested: { values: ['${MCP_TOKEN}', '$$', 'a\nb'] } });
assert.deepEqual(parsed('{"one":1,"two":[true,null]}'), { one: 1, two: [true, null] });
const denied = ['one: 1\none: 2', '{"x":1,"\\u0078":2}', 'one: &shared [1]\ntwo: *shared', 'one: !!str value', 'one: 1\n---\ntwo: 2', 'one: { <<: {two: 1} }', 'one: .inf', '['.repeat(40) + '0' + ']'.repeat(40)];
for (const source of denied) assert.throws(() => parsed(source));
const described = await describePiAdapterFiles();
assert.equal(described.ok, true);
const files = described.value;
assert.ok(Object.isFrozen(files) && Object.isFrozen(files.limits));
assert.equal(files.version, 1);
assert.equal(files.localMcpScriptDigest.hex, createHash('sha256').update(await readFile('packages/agent-pi/dist/workspace-mcp.js')).digest('hex'));
assert.equal(files.restrictionDigest.algorithm, 'sha256');
assert.equal(files.limits.artifactBytes, 268435456);
console.log(JSON.stringify({ status: 'passed', case: 'parser-descriptor', positive: 2, denied: denied.length, descriptor: files, evidenceLevel: 'static_inspection', runtimeReady: 'not_checked' }));
