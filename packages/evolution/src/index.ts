import { DatabaseSync } from 'node:sqlite';

export const EVOLUTION_PACKAGE_NAME = '@loopwright/evolution' as const;
export const EVOLUTION_SCAFFOLD_VERSION = 1 as const;

export interface EvolutionPackageDescriptor {
  readonly name: typeof EVOLUTION_PACKAGE_NAME;
  readonly version: typeof EVOLUTION_SCAFFOLD_VERSION;
  readonly sqliteBuiltin: boolean;
  readonly sqliteVersion: string;
}

export interface NodeSqliteProbeResult {
  readonly strictTablesSupported: boolean;
  readonly journalMode: string;
}

/** Return frozen metadata describing the `@loopwright/evolution` package scaffold and SQLite runtime. */
export function getEvolutionPackageDescriptor(): EvolutionPackageDescriptor {
  return Object.freeze({
    name: EVOLUTION_PACKAGE_NAME,
    version: EVOLUTION_SCAFFOLD_VERSION,
    sqliteBuiltin: typeof DatabaseSync === 'function',
    sqliteVersion: process.versions.sqlite ?? '',
  });
}

/** Verify built-in `node:sqlite` `STRICT` table creation and pragma querying against an in-memory database. */
export function probeNodeSqliteSupport(): NodeSqliteProbeResult {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE scaffold_probe (id INTEGER PRIMARY KEY) STRICT;');
    const row = db.prepare('PRAGMA journal_mode;').get() as { readonly journal_mode?: unknown } | undefined;
    const journalMode = typeof row?.journal_mode === 'string' ? row.journal_mode : '';
    return Object.freeze({
      strictTablesSupported: true,
      journalMode,
    });
  } finally {
    db.close();
  }
}
