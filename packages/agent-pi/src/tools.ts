import { createReadToolDefinition, createBashToolDefinition, createWriteToolDefinition, createEditToolDefinition, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { JsonValue } from '@earendil-works/pi-ai';
export type LocalToolName = 'read' | 'bash' | 'write' | 'edit';
export interface ToolIdentity { readonly invocation: number; readonly slot: string; readonly callId: string; readonly name: string; readonly parentId: string | null }
export interface ToolResult { readonly content: readonly { readonly type: 'text'; readonly text: string }[]; readonly isError?: boolean; readonly structuredContent?: JsonValue; readonly details: unknown }
export interface ToolExecutor {
  invoke(identity: ToolIdentity & { readonly parentRequestId: string }, bytes: Uint8Array, signal: AbortSignal, onOperation: (id: string) => void): Promise<ToolResult>;
  close(): Promise<void>;
}
/** Public native descriptors with an official custom-tool execution bridge, never SDK-local effects. */
export function bridgedTools(names: readonly string[], execute: (name: LocalToolName, id: string, args: unknown, signal?: AbortSignal) => Promise<ToolResult>): ToolDefinition[] {
  const definitions = [createReadToolDefinition('/workspace/candidate', { autoResizeImages: false }), createBashToolDefinition('/scratch', { exposeSessionEnvironment: false, shellPath: '/bin/bash' }), createWriteToolDefinition('/workspace/candidate'), createEditToolDefinition('/workspace/candidate')];
  return definitions.filter(definition => names.includes(definition.name)).map(definition => ({
    name: definition.name, label: definition.label, description: definition.description + (definition.name === 'bash' ? '\nCandidate is read-only. Each call has fresh /scratch; batch related commands in one call.' : ''),
    parameters: definition.parameters, ...(definition.outputSchema ? { outputSchema: definition.outputSchema } : {}), executionMode: 'sequential',
    execute: async (id, args, signal) => { const result = await execute(definition.name as LocalToolName, id, args, signal); return { ...result, content: [...result.content] }; },
  }));
}
