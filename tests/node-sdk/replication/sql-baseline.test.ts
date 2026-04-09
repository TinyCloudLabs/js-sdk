import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication SQL Baseline", () => {
  test(
    "executes SQLite-backed SQL through a live node with the real SDK",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-baseline");
        const alice = createClusterClient(cluster, "node-a", prefix);
        await alice.signIn();

        const suffix = Date.now();
        const dbName = `replication_sql_baseline_${suffix}`;
        const tableName = `items_sql_baseline_${suffix}`;
        const sql = alice.sql.db(dbName);

        const createResult = await sql.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)`
        );
        expect(createResult.ok).toBe(true);

        const insertResult = await sql.execute(
          `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
          ["item-1", "camera", 2]
        );
        expect(insertResult.ok).toBe(true);
        if (!insertResult.ok) {
          throw new Error(insertResult.error.message);
        }
        expect(insertResult.data.changes).toBe(1);

        const queryResult = await sql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(queryResult.ok).toBe(true);
        if (!queryResult.ok) {
          throw new Error(queryResult.error.message);
        }

        expect(queryResult.data.rowCount).toBe(1);
        expect(queryResult.data.columns).toEqual(["id", "name", "quantity"]);
        expect(queryResult.data.rows[0]).toEqual(["item-1", "camera", 2]);
      } finally {
        await cluster.stop();
      }
    }
  );
});
