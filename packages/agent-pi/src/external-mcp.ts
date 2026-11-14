import { constants as fsConstants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpFetch,
  type McpTransport,
  type Tool,
} from '@earendil-works/pi-mcp';
import { clampToolResultBytes, type ToolResult } from './tools.js';

export const EXTERNAL_MCP_TOOL_NAME_PATTERN = /^mcp__([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*)__([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)$/;
const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$/;
const MAX_MCP_SERVER_ID_LENGTH = 24;
const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;
const BARE_EXECUTABLE_PATTERN = /^[A-Za-z0-9._+-]{1,128}$/;
const DEFAULT_TRUSTED_PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';
const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_MCP_MESSAGE_BYTES = 16_777_216;
const MAX_MCP_STDERR_BYTES = 65_536;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_TOTAL_EXTERNAL_MCP_TOOLS = 120;

export interface ExternalMcpStdioServerConfig {
  readonly id: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly includeTools?: readonly string[] | undefined;
  readonly required?: boolean | undefined;
}

export interface ExternalMcpHttpServerConfig {
  readonly id: string;
  readonly transport: 'http';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly fetchImpl?: McpFetch | undefined;
  readonly allowInsecureHttp?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly includeTools?: readonly string[] | undefined;
  readonly required?: boolean | undefined;
}

export type ExternalMcpServerConfig = ExternalMcpStdioServerConfig | ExternalMcpHttpServerConfig;

export interface ExternalMcpToolSchema {
  readonly name: string;
  readonly serverId: string;
  readonly upstreamName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ConnectedMcpServerSummary {
  readonly id: string;
  readonly transport: 'stdio' | 'http';
  readonly status: 'connected' | 'failed';
  readonly toolNames: readonly string[];
  readonly error: string | null;
}

export interface ConnectHostMcpOptions {
  readonly untrustedRoots?: readonly string[] | undefined;
  readonly trustedPathEnv?: string | undefined;
  readonly scrub?: ((text: string) => string) | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

export interface CallExternalMcpToolOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxResultBytes: number;
  readonly timeoutMs?: number | undefined;
}

export function isExternalMcpToolName(name: string): boolean {
  if (name.length > MAX_PROVIDER_TOOL_NAME_LENGTH) return false;
  const match = EXTERNAL_MCP_TOOL_NAME_PATTERN.exec(name);
  return match !== null && match[1] !== 'workspace' && match[1]!.length <= MAX_MCP_SERVER_ID_LENGTH;
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = rootPath.endsWith(sep) ? rootPath.slice(0, -1) : rootPath;
  return targetPath === normalizedRoot || targetPath.startsWith(`${normalizedRoot}${sep}`);
}

async function resolveCanonicalUntrustedRoots(roots: readonly string[] | undefined): Promise<readonly string[]> {
  if (!roots || roots.length === 0) return [];
  const resolved: string[] = [];
  for (const root of roots) {
    const abs = resolve(root);
    resolved.push(abs);
    try {
      const real = await realpath(abs);
      if (real !== abs) resolved.push(real);
    } catch {
      // Ignore missing root paths while retaining lexical path guard.
    }
  }
  return resolved;
}

async function verifyExecutableCandidate(candidatePath: string, untrustedRoots: readonly string[]): Promise<string | null> {
  if (!isAbsolute(candidatePath)) return null;
  for (const untrusted of untrustedRoots) {
    if (isInsideRoot(candidatePath, untrusted)) return null;
  }
  try {
    await access(candidatePath, fsConstants.X_OK);
    const real = await realpath(candidatePath);
    for (const untrusted of untrustedRoots) {
      if (isInsideRoot(real, untrusted)) return null;
    }
    const info = await lstat(real);
    if (!info.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

async function resolveTrustedStdioCommand(
  rawCommand: string,
  trustedPathEnv: string,
  untrustedRoots: readonly string[],
): Promise<string> {
  if (rawCommand.includes('/') || rawCommand.includes('\\')) {
    if (!isAbsolute(rawCommand) || rawCommand.includes('\\') || rawCommand.includes('\0')) {
      throw new Error(`MCP stdio command "${rawCommand}" must be a bare executable name or absolute path`);
    }
    const verified = await verifyExecutableCandidate(rawCommand, untrustedRoots);
    if (verified === null) {
      throw new Error(`MCP stdio command "${rawCommand}" is missing, not executable, or inside an untrusted root`);
    }
    return verified;
  }

  if (!BARE_EXECUTABLE_PATTERN.test(rawCommand)) {
    throw new Error(`MCP stdio command "${rawCommand}" contains invalid characters`);
  }

  const dirs = `${trustedPathEnv}${delimiter}${DEFAULT_TRUSTED_PATH}`
    .split(delimiter)
    .map(part => part.trim())
    .filter(part => part.length > 0 && isAbsolute(part));
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (untrustedRoots.some(root => isInsideRoot(dir, root))) continue;
    const candidate = join(dir, rawCommand);
    const verified = await verifyExecutableCandidate(candidate, untrustedRoots);
    if (verified !== null) return verified;
  }
  throw new Error(`MCP stdio command "${rawCommand}" was not found on trusted PATH`);
}

function sanitizeToolSegment(upstreamName: string, usedNames: ReadonlySet<string>, serverId: string): string {
  const maxSegmentLength = Math.max(8, MAX_PROVIDER_TOOL_NAME_LENGTH - `mcp__${serverId}__`.length);
  const cleaned = upstreamName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, Math.max(4, maxSegmentLength - 4));
  const base = cleaned.length > 0 ? cleaned : 'tool';
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(`mcp__${serverId}__${candidate}`)) {
    const tag = `_${suffix++}`;
    candidate = `${base.slice(0, Math.max(1, maxSegmentLength - tag.length))}${tag}`;
  }
  return candidate;
}

const DISALLOWED_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '__proto__',
  'constructor',
  'prototype',
]);

function sanitizeJsonSchemaValue(value: unknown, depth: number): unknown {
  if (depth > 16 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.slice(0, 2048);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, 64)) {
      const clean = sanitizeJsonSchemaValue(item, depth + 1);
      if (clean !== undefined) items.push(clean);
    }
    return items;
  }
  if (typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const key of Object.keys(raw)) {
      if (DISALLOWED_SCHEMA_KEYS.has(key)) continue;
      if (key === '$ref') {
        const refVal = raw[key];
        if (typeof refVal !== 'string' || !refVal.startsWith('#/')) continue;
      }
      if (++count > 64) break;
      const clean = sanitizeJsonSchemaValue(raw[key], depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

export function sanitizeMcpToolInputSchema(rawSchema: unknown): Readonly<Record<string, unknown>> {
  const cleaned = sanitizeJsonSchemaValue(rawSchema, 0);
  if (cleaned === null || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
    return Object.freeze({ type: 'object', properties: {} });
  }
  const obj = cleaned as Record<string, unknown>;
  if (obj['type'] !== 'object') {
    obj['type'] = 'object';
  }
  if (obj['properties'] === undefined || typeof obj['properties'] !== 'object' || obj['properties'] === null || Array.isArray(obj['properties'])) {
    obj['properties'] = {};
  }
  return Object.freeze(obj);
}

interface RegisteredExternalTool {
  readonly schema: ExternalMcpToolSchema;
  readonly client: McpClient;
  readonly timeoutMs: number;
}

interface ConnectedServerHandle {
  readonly id: string;
  readonly client: McpClient;
  readonly transport: McpTransport;
}

/**
 * Host-owned multi-server MCP client registry supporting both `stdio` and Streamable `http`
 * MCP servers. Keeps credentials and network/child-process authority strictly inside the
 * trusted host process while exposing scrubbed, byte-bounded `read_only` tool definitions.
 */
export class HostMcpRegistry {
  readonly #servers: readonly ConnectedMcpServerSummary[];
  readonly #handles: readonly ConnectedServerHandle[];
  readonly #toolsByName: ReadonlyMap<string, RegisteredExternalTool>;
  readonly #scrub: (text: string) => string;
  readonly #onLog: ((message: string) => void) | undefined;
  #closed = false;

  private constructor(
    servers: readonly ConnectedMcpServerSummary[],
    handles: readonly ConnectedServerHandle[],
    toolsByName: ReadonlyMap<string, RegisteredExternalTool>,
    scrub: (text: string) => string,
    onLog: ((message: string) => void) | undefined,
  ) {
    this.#servers = Object.freeze([...servers]);
    this.#handles = handles;
    this.#toolsByName = toolsByName;
    this.#scrub = scrub;
    this.#onLog = onLog;
  }

  static async connect(
    configs: readonly ExternalMcpServerConfig[],
    options: ConnectHostMcpOptions = {},
  ): Promise<HostMcpRegistry> {
    const scrub = options.scrub ?? ((text: string) => text);
    const untrustedRoots = await resolveCanonicalUntrustedRoots(options.untrustedRoots);
    const trustedPathEnv = options.trustedPathEnv ?? process.env['PATH'] ?? DEFAULT_TRUSTED_PATH;

    const summaries: ConnectedMcpServerSummary[] = [];
    const handles: ConnectedServerHandle[] = [];
    const toolsByName = new Map<string, RegisteredExternalTool>();
    const usedNames = new Set<string>(['mcp__workspace__read_file']);
    const seenServerIds = new Set<string>();

    try {
      for (const config of configs) {
        if (
          config.id.length > MAX_MCP_SERVER_ID_LENGTH
          || !MCP_SERVER_ID_PATTERN.test(config.id)
          || config.id === 'workspace'
        ) {
          throw new Error(`Invalid or reserved MCP server id "${config.id}"`);
        }
        if (seenServerIds.has(config.id)) {
          throw new Error(`Duplicate MCP server id "${config.id}"`);
        }
        seenServerIds.add(config.id);

        const timeoutMs = config.timeoutMs !== undefined && Number.isSafeInteger(config.timeoutMs) && config.timeoutMs >= 100
          ? Math.min(config.timeoutMs, 600_000)
          : DEFAULT_MCP_TIMEOUT_MS;

        let transport: McpTransport | undefined;
        let client: McpClient | undefined;
        try {
          if (config.transport === 'stdio') {
            const executable = await resolveTrustedStdioCommand(config.command, trustedPathEnv, untrustedRoots);
            const childEnv: Record<string, string> = {
              PATH: DEFAULT_TRUSTED_PATH,
              HOME: process.env['HOME'] ?? '/tmp',
              TMPDIR: process.env['TMPDIR'] ?? '/tmp',
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              ...(config.env ?? {}),
            };
            transport = new StdioTransport({
              command: executable,
              args: config.args ?? [],
              ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
              env: childEnv,
              inheritEnv: false,
              stderr: 'pipe',
              maxMessageBytes: MAX_MCP_MESSAGE_BYTES,
              maxStderrBytes: MAX_MCP_STDERR_BYTES,
              closeTimeoutMs: 2_000,
            });
          } else {
            let parsedUrl: URL;
            try {
              parsedUrl = new URL(config.url);
            } catch {
              throw new Error(`Invalid HTTP MCP URL for server "${config.id}"`);
            }
            if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
              throw new Error(`HTTP MCP URL for server "${config.id}" must not embed credentials`);
            }
            const allowHttp = config.allowInsecureHttp === true && parsedUrl.protocol === 'http:';
            if (parsedUrl.protocol !== 'https:' && !allowHttp) {
              throw new Error(`HTTP MCP server "${config.id}" requires https:// URL`);
            }
            transport = new StreamableHttpTransport({
              url: parsedUrl,
              ...(config.headers !== undefined ? { headers: { ...config.headers } } : {}),
              ...(config.fetchImpl !== undefined ? { fetch: config.fetchImpl } : {}),
              openGetStream: false,
              maxMessageBytes: MAX_MCP_MESSAGE_BYTES,
              reconnect: {
                initialDelayMs: 250,
                maxDelayMs: 1_000,
                maxRetries: 1,
              },
            });
          }

          client = new McpClient({
            name: 'loopwright',
            version: '0.1.0',
            requestTimeoutMs: timeoutMs,
          });
          client.onError(() => {
            // Suppress unhandled transport errors; individual tool calls report soft errors.
          });

          await client.connect(transport);
          const listedTools: Tool[] = await client.listTools({ timeoutMs });
          const allowSet = config.includeTools && config.includeTools.length > 0
            ? new Set(config.includeTools)
            : null;
          const filtered = listedTools
            .filter(tool => typeof tool.name === 'string' && tool.name.length > 0 && (allowSet === null || allowSet.has(tool.name)))
            .slice(0, MAX_TOOLS_PER_SERVER);

          const registeredForServer: string[] = [];
          for (const tool of filtered) {
            if (toolsByName.size >= MAX_TOTAL_EXTERNAL_MCP_TOOLS) break;
            const segment = sanitizeToolSegment(tool.name, usedNames, config.id);
            const fullName = `mcp__${config.id}__${segment}`;
            usedNames.add(fullName);
            const description = scrub((tool.description ?? `MCP tool ${tool.name} from ${config.id}`).slice(0, 2048));
            const schema: ExternalMcpToolSchema = Object.freeze({
              name: fullName,
              serverId: config.id,
              upstreamName: tool.name,
              description: `[MCP ${config.id}/${tool.name}] ${description}`,
              inputSchema: sanitizeMcpToolInputSchema(tool.inputSchema),
            });
            toolsByName.set(fullName, { schema, client, timeoutMs });
            registeredForServer.push(fullName);
          }

          handles.push({ id: config.id, client, transport });
          summaries.push(Object.freeze({
            id: config.id,
            transport: config.transport,
            status: 'connected',
            toolNames: Object.freeze(registeredForServer),
            error: null,
          }));
          options.onLog?.(
            `Connected MCP server "${config.id}" (${config.transport}): ${registeredForServer.length} tool${registeredForServer.length === 1 ? '' : 's'} ready`,
          );
        } catch (error) {
          await client?.close().catch(() => undefined);
          await transport?.close().catch(() => undefined);
          const detail = scrub(error instanceof Error ? error.message : String(error));
          if (config.required === true) {
            throw new Error(`Required MCP server "${config.id}" failed to initialize: ${detail}`, { cause: error });
          }
          summaries.push(Object.freeze({
            id: config.id,
            transport: config.transport,
            status: 'failed',
            toolNames: Object.freeze([]),
            error: detail,
          }));
          options.onLog?.(`Warning: MCP server "${config.id}" (${config.transport}) unavailable: ${detail}`);
        }
      }

      return new HostMcpRegistry(summaries, handles, toolsByName, scrub, options.onLog);
    } catch (error) {
      for (const handle of handles) {
        await handle.client.close().catch(() => undefined);
        await handle.transport.close().catch(() => undefined);
      }
      throw error;
    }
  }

  get servers(): readonly ConnectedMcpServerSummary[] {
    return this.#servers;
  }

  get toolNames(): readonly string[] {
    return Object.freeze([...this.#toolsByName.keys()]);
  }

  hasTool(name: string): boolean {
    return this.#toolsByName.has(name);
  }

  targetIdentityFor(name: string): string | null {
    const entry = this.#toolsByName.get(name);
    if (!entry) return null;
    return `mcp:${entry.schema.serverId}:${entry.schema.upstreamName}`;
  }

  toolSchemasFor(allowedToolNames: readonly string[]): readonly ExternalMcpToolSchema[] {
    const allowed = new Set(allowedToolNames);
    const result: ExternalMcpToolSchema[] = [];
    for (const [name, entry] of this.#toolsByName.entries()) {
      if (allowed.has(name)) result.push(entry.schema);
    }
    return Object.freeze(result);
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: CallExternalMcpToolOptions,
  ): Promise<ToolResult> {
    const startedMs = performance.now();
    if (this.#closed) {
      return clampToolResultBytes(
        { content: [{ type: 'text', text: `MCP error (${name}): MCP registry is closed` }], isError: true, details: null },
        options.maxResultBytes,
        { tool: 'bash' },
      );
    }
    const entry = this.#toolsByName.get(name);
    if (!entry) {
      return clampToolResultBytes(
        { content: [{ type: 'text', text: `MCP error: unknown MCP tool "${name}"` }], isError: true, details: null },
        options.maxResultBytes,
        { tool: 'bash' },
      );
    }

    try {
      const rawResult = await entry.client.callTool(
        entry.schema.upstreamName,
        { ...args },
        {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          timeoutMs: options.timeoutMs ?? entry.timeoutMs,
        },
      );
      const llmBlocks = toLlmContent(rawResult);
      const textParts: string[] = [];
      for (const block of llmBlocks) {
        if (block.type === 'text') {
          textParts.push(this.#scrub(block.text));
        } else {
          textParts.push(`[MCP binary image (${this.#scrub(block.mimeType)}) omitted in text-only session]`);
        }
      }
      if (textParts.length === 0) {
        textParts.push(rawResult.isError ? 'MCP tool returned an empty error response.' : '(empty MCP tool response)');
      }
      const elapsedMs = Math.max(1, Math.round(performance.now() - startedMs));
      this.#onLog?.(
        `MCP ${entry.schema.serverId}/${entry.schema.upstreamName} ${rawResult.isError ? 'returned error' : 'completed'} (${elapsedMs}ms)`,
      );
      const shaped: ToolResult = {
        content: [{ type: 'text', text: textParts.join('\n') }],
        ...(rawResult.isError === true ? { isError: true } : {}),
        details: null,
      };
      return clampToolResultBytes(shaped, options.maxResultBytes, { tool: 'bash' });
    } catch (error) {
      const elapsedMs = Math.max(1, Math.round(performance.now() - startedMs));
      const detail = this.#scrub(error instanceof Error ? error.message : String(error));
      this.#onLog?.(`MCP ${entry.schema.serverId}/${entry.schema.upstreamName} failed (${elapsedMs}ms): ${detail}`);
      return clampToolResultBytes(
        {
          content: [{ type: 'text', text: `MCP tool error (${entry.schema.serverId}/${entry.schema.upstreamName}): ${detail}` }],
          isError: true,
          details: null,
        },
        options.maxResultBytes,
        { tool: 'bash' },
      );
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const handle of this.#handles) {
      await handle.client.close().catch(() => undefined);
      await handle.transport.close().catch(() => undefined);
    }
  }
}
