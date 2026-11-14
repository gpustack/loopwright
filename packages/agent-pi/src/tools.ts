import { createReadToolDefinition, createBashToolDefinition, createWriteToolDefinition, createEditToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { JsonValue } from '@earendil-works/pi-ai';
import { canonical } from './boundary.js';
import { isExternalMcpToolName, type ExternalMcpToolSchema } from './external-mcp.js';
export type LocalToolName = 'read' | 'bash' | 'write' | 'edit' | 'delete';
export type BridgedToolName = LocalToolName | string;
export interface ToolIdentity { readonly invocation: number; readonly slot: string; readonly callId: string; readonly name: string; readonly parentId: string | null }
export interface ToolResult { readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly isError?: boolean; readonly structuredContent?: JsonValue; readonly details: unknown }
export interface ToolExecutor {
  invoke(identity: ToolIdentity & { readonly parentRequestId: string }, bytes: Uint8Array, signal: AbortSignal, onOperation: (id: string) => void): Promise<ToolResult>;
  close(): Promise<void>;
}
const deleteParameters: ToolDefinition['parameters'] = {
  type: 'object',
  properties: { path: { type: 'string', description: 'Repository-relative path to the file to delete (e.g. pack/matrix.yaml, without ./candidate/)' } },
  required: ['path'],
  additionalProperties: false,
};
const deleteToolDefinition: ToolDefinition = {
  name: 'delete',
  label: 'delete',
  description: 'Delete a writable file in /workspace/candidate using a repository-relative path (e.g. pack/matrix.yaml, without ./candidate/).',
  parameters: deleteParameters,
  executionMode: 'sequential',
  execute: async () => ({ content: [], details: null }),
};
/** Public native descriptors with an official custom-tool execution bridge, never SDK-local effects. */
export function bridgedTools(
  names: readonly string[],
  execute: (name: BridgedToolName, id: string, args: unknown, signal?: AbortSignal) => Promise<ToolResult>,
  externalMcpTools: readonly ExternalMcpToolSchema[] = [],
): ToolDefinition[] {
  const editDef = createEditToolDefinition('/workspace/candidate');
  const editParamsRecord = editDef.parameters as unknown as { properties?: Record<string, unknown> };
  const editWithShorthand: ToolDefinition = {
    name: editDef.name,
    label: editDef.label,
    description: editDef.description,
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        ...(editParamsRecord.properties ?? {}),
        oldText: { type: 'string', description: 'Exact text to replace (single-edit shorthand when edits array is omitted).' },
        newText: { type: 'string', description: 'Replacement text (single-edit shorthand when edits array is omitted).' },
      },
    } as unknown as ToolDefinition['parameters'],
    ...(editDef.outputSchema ? { outputSchema: editDef.outputSchema } : {}),
    executionMode: 'sequential',
    execute: async () => ({ content: [], details: null }),
  };
  const definitions = [createReadToolDefinition('/workspace/candidate', { autoResizeImages: false }), createBashToolDefinition('/scratch', { exposeSessionEnvironment: false, shellPath: '/bin/bash' }), createWriteToolDefinition('/workspace/candidate'), editWithShorthand, deleteToolDefinition];
  const localTools: ToolDefinition[] = definitions.filter(definition => names.includes(definition.name)).map(definition => ({
    name: definition.name,
    label: definition.label,
    description: definition.description + (
      definition.name === 'bash'
        ? '\nCandidate is read-only (/workspace/candidate or $CANDIDATE_DIR / ./candidate in bash; pass repository-relative paths such as pack/matrix.yaml without ./candidate/ to read, write, edit, and delete). Each call has fresh /scratch; batch related commands in one call.'
        : definition.name === 'delete'
          ? ''
          : '\nPass a repository-relative file path (e.g. pack/matrix.yaml, without ./candidate/).'
    ),
    parameters: definition.parameters,
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}),
    executionMode: 'sequential',
    execute: async (id, args, signal) => { const result = await execute(definition.name as LocalToolName, id, args, signal); return { ...result, content: [...result.content] }; },
  }));
  const mcpTools: ToolDefinition[] = externalMcpTools
    .filter(schema => names.includes(schema.name) && isExternalMcpToolName(schema.name))
    .map(schema => ({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: schema.inputSchema as unknown as ToolDefinition['parameters'],
      executionMode: 'sequential',
      execute: async (id, args, signal) => {
        const result = await execute(schema.name, id, args, signal);
        return { ...result, content: [...result.content] };
      },
    }));
  return [...localTools, ...mcpTools];
}

/** Bound serialized ToolResult bytes (including JSON quote/newline escaping and wrapper headroom) on clean line/codepoint boundaries. */
export function clampToolResultBytes(
  result: ToolResult,
  resultBytes: number,
  options: { readonly tool: 'read' | 'bash'; readonly offset?: unknown },
): ToolResult {
  if (result.content.some(item => item.type !== 'text')) return result;
  const envelopeMax = resultBytes > 4608 ? resultBytes - 4096 : Math.max(0, resultBytes - 128);
  const targetMax = options.tool === 'read' ? Math.min(32768, envelopeMax) : envelopeMax;
  if (Buffer.byteLength(canonical(result)) <= targetMax) return result;

  const rawText = result.content.map(item => item.text).join('\n');
  const stripped = options.tool === 'read'
    ? rawText.replace(/\n*\[Showing lines \d+-\d+ of \d+[^\]]*\]\s*$/u, '')
    : rawText;
  const startLine = typeof options.offset === 'number' && Number.isSafeInteger(options.offset) && options.offset >= 1
    ? options.offset
    : 1;
  const build = (prefix: string): ToolResult => {
    const keptLines = prefix.length === 0 ? 0 : prefix.split('\n').length;
    const notice = options.tool === 'read'
      ? `\n\n[Showing ${keptLines} lines starting at line ${startLine}; truncated to fit tool result byte limit. Use offset=${startLine + Math.max(1, keptLines)} to continue reading.]`
      : '\n\n[Output truncated to fit tool result byte limit.]';
    return {
      content: [{ type: 'text', text: prefix + notice }],
      details: null,
      ...(result.isError ? { isError: true } : {}),
    };
  };
  if (Buffer.byteLength(canonical(build(''))) > targetMax) return result;

  const lines = stripped.split('\n');
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(canonical(build(lines.slice(0, mid).join('\n')))) <= targetMax) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  if (low > 0) return build(lines.slice(0, low).join('\n'));

  const codepoints = Array.from(stripped);
  let cpLow = 0;
  let cpHigh = codepoints.length;
  while (cpLow < cpHigh) {
    const mid = Math.ceil((cpLow + cpHigh) / 2);
    if (Buffer.byteLength(canonical(build(codepoints.slice(0, mid).join('')))) <= targetMax) {
      cpLow = mid;
    } else {
      cpHigh = mid - 1;
    }
  }
  return build(codepoints.slice(0, cpLow).join(''));
}
