import { Database } from "bun:sqlite";
import type { FeedDatabase } from "./types";
import type { IDatabaseHandle } from "../sql/ISQLService";
import type { Result } from "../types";
import type { SqlValue } from "../sql/types";

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

export function sqliteHandle(path = ":memory:"): { handle: FeedDatabase; close: () => void } {
  const database = new Database(path);
  const execute: IDatabaseHandle["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    close: () => database.close(),
    handle: {
      query: async <T>(sql: string, params: SqlValue[] = []) => {
        const statement = database.query(sql);
        const rows = statement.values(...params) as T[][];
        return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
      },
      execute,
      batch: async (statements) => {
        database.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(unwrap(await execute(statement.sql, statement.params)));
          database.exec("COMMIT");
          return { ok: true, data: { results } };
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
}
