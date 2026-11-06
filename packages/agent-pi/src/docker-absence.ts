/** Exact inspected IDs or private nonce names only; generic names and daemon errors prove nothing. */
export function isAbsentContainer(id: string, error: unknown): boolean {
  if (!/^(?:[a-f0-9]{64}|lw-pi-(?:(?:tool|mcp)-)?[a-f0-9]{32})$/.test(id) || !error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  if (value.code !== 1 || typeof value.stdout !== 'string' || !['', '[]'].includes(value.stdout.trim()) || typeof value.stderr !== 'string' || value.stderr.length > 512) return false;
  return new RegExp('^error: no such (?:object|container): ' + id + '\\s*$', 'i').test(value.stderr);
}
