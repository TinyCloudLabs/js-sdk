import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openSqlReplicationSession,
  reconcileSqlFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication SQL Schema Drift", () => {
  test(
    "lets the authority snapshot override divergent local SQL schema on node-b",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-schema-drift");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const drifted = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const driftedNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await drifted.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(drifted.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_schema_drift_${suffix}`;
        const tableName = `items_sql_schema_drift_${suffix}`;
        const authoritySql = authority.sql.db(dbName);
        const driftedSql = drifted.sql.db(dbName);

        const localCreate = await driftedSql.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, label TEXT NOT NULL, local_only INTEGER NOT NULL)`
        );
        expect(localCreate.ok).toBe(true);

        const localInsert = await driftedSql.execute(
          `INSERT INTO ${tableName} (id, label, local_only) VALUES (?, ?, ?)`,
          ["local-1", "replica-only", 1]
        );
        expect(localInsert.ok).toBe(true);

        const authorityCreate = await authoritySql.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)`
        );
        expect(authorityCreate.ok).toBe(true);

        const authorityInsert = await authoritySql.execute(
          `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
          ["item-1", "camera", 2]
        );
        expect(authorityInsert.ok).toBe(true);

        await waitForCondition("node-b sees divergent local SQL state", async () => {
          const result = await driftedSql.query(
            `SELECT id, label, local_only FROM ${tableName} WHERE id = ?`,
            ["local-1"]
          );
          return result.ok && result.data.rowCount === 1;
        });

        const localDriftQuery = await driftedSql.query(
          `SELECT id, label, local_only FROM ${tableName} WHERE id = ?`,
          ["local-1"]
        );
        expect(localDriftQuery.ok).toBe(true);
        if (!localDriftQuery.ok) {
          throw new Error(localDriftQuery.error.message);
        }
        expect(localDriftQuery.data.rows[0]).toEqual(["local-1", "replica-only", 1]);

        const reconcileSession = await openSqlReplicationSession(
          authority,
          authorityNode.url,
          dbName
        );
        const targetSession = await openSqlReplicationSession(
          drifted,
          driftedNode.url,
          dbName
        );
        const reconcileResult = await reconcileSqlFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          dbName,
        }, { target: targetSession, peer: reconcileSession });

        expect(reconcileResult.spaceId).toBe(authority.spaceId);
        expect(reconcileResult.dbName).toBe(dbName);
        expect(reconcileResult.peerUrl).toBe(authorityNode.url);
        expect(reconcileResult.snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("authority snapshot overrides node-b drift", async () => {
          const result = await driftedSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return (
            result.ok &&
            result.data.rowCount === 1 &&
            result.data.rows[0][1] === "camera" &&
            result.data.rows[0][2] === 2
          );
        });

        const canonicalQuery = await driftedSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(canonicalQuery.ok).toBe(true);
        if (!canonicalQuery.ok) {
          throw new Error(canonicalQuery.error.message);
        }
        expect(canonicalQuery.data.columns).toEqual(["id", "name", "quantity"]);
        expect(canonicalQuery.data.rows[0]).toEqual(["item-1", "camera", 2]);

        const driftColumnQuery = await driftedSql.query(
          `SELECT id, label, local_only FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(driftColumnQuery.ok).toBe(false);
      } finally {
        await cluster.stop();
      }
    }
  );
});
