import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  exportSqlFromPeer,
  getClusterNode,
  openSqlReplicationSession,
  reconcileSqlFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication SQL Reconcile", () => {
  test(
    "pulls real SQLite insert, update, and delete changes from one live node into another live node",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-reconcile");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_reconcile_${suffix}`;
        const tableName = `items_sql_reconcile_${suffix}`;
        const authoritySql = authority.sql.db(dbName);
        const replicaSql = replica.sql.db(dbName);

        const createResult = await authoritySql.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)`
        );
        expect(createResult.ok).toBe(true);

        const insertResult = await authoritySql.execute(
          `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
          ["item-1", "camera", 2]
        );
        expect(insertResult.ok).toBe(true);

        const exportSession = await openSqlReplicationSession(
          authority,
          authorityNode.url,
          dbName
        );
        const targetSession = await openSqlReplicationSession(
          replica,
          replicaNode.url,
          dbName
        );
        const exportResult = await exportSqlFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            dbName,
          },
          exportSession
        );
        expect(exportResult.spaceId).toBe(authority.spaceId);
        expect(exportResult.dbName).toBe(dbName);
        expect(exportResult.snapshot.length).toBeGreaterThan(0);

        const reconcileResult = await reconcileSqlFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          dbName,
        }, { target: targetSession, peer: exportSession });

        expect(reconcileResult.spaceId).toBe(authority.spaceId);
        expect(reconcileResult.dbName).toBe(dbName);
        expect(reconcileResult.peerUrl).toBe(authorityNode.url);
        expect(reconcileResult.snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replicated SQL row available on node-b", async () => {
          const queryResult = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return queryResult.ok && queryResult.data.rowCount === 1;
        });

        const replicaQuery = await replicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(replicaQuery.ok).toBe(true);
        if (!replicaQuery.ok) {
          throw new Error(replicaQuery.error.message);
        }
        expect(replicaQuery.data.columns).toEqual(["id", "name", "quantity"]);
        expect(replicaQuery.data.rows[0]).toEqual(["item-1", "camera", 2]);

        const updateResult = await authoritySql.execute(
          `UPDATE ${tableName} SET name = ?, quantity = ? WHERE id = ?`,
          ["camera-pro", 4, "item-1"]
        );
        expect(updateResult.ok).toBe(true);

        const secondPass = await reconcileSqlFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          dbName,
        }, { target: targetSession, peer: exportSession });
        expect(secondPass.snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("updated SQL row available on node-b", async () => {
          const queryResult = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return (
            queryResult.ok &&
            queryResult.data.rowCount === 1 &&
            queryResult.data.rows[0][1] === "camera-pro" &&
            queryResult.data.rows[0][2] === 4
          );
        });

        const updatedReplicaQuery = await replicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(updatedReplicaQuery.ok).toBe(true);
        if (!updatedReplicaQuery.ok) {
          throw new Error(updatedReplicaQuery.error.message);
        }
        expect(updatedReplicaQuery.data.rows[0]).toEqual(["item-1", "camera-pro", 4]);

        const deleteResult = await authoritySql.execute(
          `DELETE FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(deleteResult.ok).toBe(true);

        const thirdPass = await reconcileSqlFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          dbName,
        }, { target: targetSession, peer: exportSession });
        expect(thirdPass.snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("deleted SQL row removed from node-b", async () => {
          const queryResult = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return queryResult.ok && queryResult.data.rowCount === 0;
        });

        const deletedReplicaQuery = await replicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(deletedReplicaQuery.ok).toBe(true);
        if (!deletedReplicaQuery.ok) {
          throw new Error(deletedReplicaQuery.error.message);
        }
        expect(deletedReplicaQuery.data.rowCount).toBe(0);
      } finally {
        await cluster.stop();
      }
    }
  );
});
