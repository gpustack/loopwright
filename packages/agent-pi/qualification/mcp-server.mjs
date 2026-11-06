/* global process */
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line.length > 65536) throw new Error('fixture frame cap');
  const message = JSON.parse(line);
  const reply = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: value }) + '\n');
  if (message.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 's03-owned-workspace-fixture', version: '1' } });
  else if (message.method === 'tools/list') reply({ tools: ['read_file', 'denied_write'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } })) });
  else if (message.method === 'tools/call') {
    process.stderr.write(JSON.stringify({ called: message.params.name }) + '\n');
    if (message.params.name !== 'read_file' || message.params.arguments.path !== 'allowed.txt') reply({ isError: true, content: [{ type: 'text', text: 'denied fixture effect' }] });
    else reply({ content: [{ type: 'text', text: await readFile('/workspace/candidate/allowed.txt', 'utf8') }] });
  } else if (message.id !== undefined) reply({});
}
