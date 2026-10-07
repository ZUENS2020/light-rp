import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** Real SQLite/FTS5, foreign keys, triggers and atomic rollback; never an in-memory map mock. */
export function createTestD1(options: { schema?: boolean; filename?: string } = {}) {
  const sqlite = new Database(options.filename ?? ':memory:');
  sqlite.pragma('foreign_keys = ON');
  if (options.schema !== false) {
    const directory = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort())
      sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
  class Prepared {
    values: unknown[] = [];
    constructor(readonly sql: string) {}
    bind(...values: unknown[]) {
      const bound = new Prepared(this.sql);
      bound.values = values;
      return bound;
    }
    execute() {
      const start = performance.now(),
        statement = sqlite.prepare(this.sql);
      const results = statement.reader ? statement.all(...this.values) : [];
      const write = statement.reader ? null : statement.run(...this.values);
      return {
        success: true,
        results,
        meta: {
          changes: write?.changes ?? 0,
          last_row_id: Number(write?.lastInsertRowid ?? 0),
          duration: performance.now() - start,
          rows_read: results.length,
          rows_written: write?.changes ?? 0,
          size_after: 0,
          changed_db: (write?.changes ?? 0) > 0,
        },
      };
    }
    async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
      const row = sqlite.prepare(this.sql).get(...this.values) as
        Record<string, unknown> | undefined;
      if (!row) return null;
      return (column ? (row[column] ?? null) : row) as T | null;
    }
    async all<T = Record<string, unknown>>() {
      return this.execute() as unknown as D1Result<T>;
    }
    async run() {
      return this.execute() as unknown as D1Result;
    }
    async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
      const statement = sqlite.prepare(this.sql),
        rows = statement.raw(true).all(...this.values);
      return (
        options?.columnNames ? [statement.columns().map((column) => column.name), ...rows] : rows
      ) as T[];
    }
  }
  const db = {
    prepare: (sql: string) => new Prepared(sql),
    batch: async (statements: Prepared[]) =>
      sqlite.transaction(() => statements.map((statement) => statement.execute()))(),
    exec: async (sql: string) => {
      const start = performance.now();
      sqlite.exec(sql);
      return { count: 1, duration: performance.now() - start };
    },
  } as unknown as D1Database;
  return { db, sqlite, close: () => sqlite.close() };
}
