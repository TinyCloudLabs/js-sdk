import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openSqlReplicationSession,
  reconcileSqlFromPeer,
  sqlReplicationBytes,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication SQL Schema Fallback", () => {
  test(
    "falls back to snapshot reconciliation after an authority-side schema change",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-schema-fallback");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_schema_fallback_${suffix}`;
        const tableName = `items_sql_schema_fallback_${suffix}`;
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

        const baselineApply = await reconcileSqlFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
          },
          { target: targetSession, peer: exportSession }
        );

        expect(sqlReplicationBytes(baselineApply).snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica sees baseline SQL row", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return query.ok && query.data.rowCount === 1;
        });

        const baselineSeq = baselineApply.appliedUntilSeq ?? 0;

        const addColumnResult = await authoritySql.execute(
          `ALTER TABLE ${tableName} ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`
        );
        expect(addColumnResult.ok).toBe(true);

        const updateResult = await authoritySql.execute(
          `UPDATE ${tableName} SET status = ? WHERE id = ?`,
          ["updated", "item-1"]
        );
        expect(updateResult.ok).toBe(true);

        const secondInsert = await authoritySql.execute(
          `INSERT INTO ${tableName} (id, name, quantity, status) VALUES (?, ?, ?, ?)`,
          ["item-2", "tripod", 1, "new"]
        );
        expect(secondInsert.ok).toBe(true);

        const fallbackApply = await reconcileSqlFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
            sinceSeq: baselineSeq,
          },
          { target: targetSession, peer: exportSession }
        );

        if (fallbackApply.mode !== undefined) {
          expect(fallbackApply.mode).toBe("snapshot");
        }
        expect(sqlReplicationBytes(fallbackApply).snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica sees schema fallback snapshot", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity, status FROM ${tableName} ORDER BY id`
          );
          return (
            query.ok &&
            query.data.rowCount === 2 &&
            query.data.rows[0][0] === "item-1" &&
            query.data.rows[0][3] === "updated" &&
            query.data.rows[1][0] === "item-2" &&
            query.data.rows[1][3] === "new"
          );
        });

        const replicaQuery = await replicaSql.query(
          `SELECT id, name, quantity, status FROM ${tableName} ORDER BY id`
        );
        expect(replicaQuery.ok).toBe(true);
        if (!replicaQuery.ok) {
          throw new Error(replicaQuery.error.message);
        }
        expect(replicaQuery.data.rows).toEqual([
          ["item-1", "camera", 2, "updated"],
          ["item-2", "tripod", 1, "new"],
        ]);
      } finally {
        await cluster.stop();
      }
    }
  );
});
