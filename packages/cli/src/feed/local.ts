import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import type { SqlValue } from "@tinycloud/sdk-services/sql";
import type { Result } from "@tinycloud/sdk-services";

type Statement = {
  all(...params: SqlValue[]): Record<string, unknown>[];
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};
type NativeDatabase = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };

export interface LocalFeedHandoff {
  handle: FeedDatabase;
  close(): void;
}

export async function openFeedHandoff(path: string): Promise<LocalFeedHandoff> {
  // Same built-in SQLite runtime boundary used by tc replica; never an in-memory fallback.
  const bun = "Bun" in globalThis;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!bun && !(major > 22 || (major === 22 && minor >= 13))) {
    throw new Error("Feed watch requires Bun or Node.js 22.13+ for its durable SQLite handoff");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const specifier = [bun ? "bun" : "node", "sqlite"].join(":");
  // These platform-specific built-ins cannot both be statically imported.
  const module = await import(specifier);
  const Database = (bun ? module.Database : module.DatabaseSync) as new (path: string) => NativeDatabase;
  const database = new Database(path);
  await chmod(path, 0o600);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000");
  const failure = (error: unknown): Result<never> => ({
    ok: false, error: { code: "SQL_ERROR", message: error instanceof Error ? error.message : "Local handoff SQLite operation failed", service: "sql" },
  });
  const run = (sql: string, params: SqlValue[] = []) => {
    const result = database.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  };
  return {
    close: () => database.close(),
    handle: {
      query: async <T>(sql: string, params: SqlValue[] = []) => {
        try {
          const records = database.prepare(sql).all(...params);
          const columns = records[0] ? Object.keys(records[0]) : [];
          return { ok: true, data: { columns, rows: records.map((row) => columns.map((column) => row[column])) as T[][], rowCount: records.length } };
        } catch (error) { return failure(error); }
      },
      execute: async (sql, params) => {
        try { return { ok: true, data: run(sql, params) }; }
        catch (error) { return failure(error); }
      },
      batch: async (statements) => {
        try {
          database.exec("BEGIN IMMEDIATE");
          const results = statements.map((statement) => run(statement.sql, statement.params));
          database.exec("COMMIT");
          return { ok: true, data: { results } };
        } catch (error) {
          if (database) { try { database.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ } }
          return failure(error);
        }
      },
    },
  };
}
