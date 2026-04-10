import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openSqlReplicationSession,
  reconcileSqlFromPeer,
  sqlReplicationBytes,
  sqlReplicationMode,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication SQL Conflict Fallback", () => {
  test(
    "falls back to a snapshot when an incremental SQL changeset conflicts with local replica state",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-conflict-fallback");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_conflict_fallback_${suffix}`;
        const tableName = `items_sql_conflict_fallback_${suffix}`;
        const authoritySql = authority.sql.db(dbName);
        const replicaSql = replica.sql.db(dbName);

        expect(
          (
            await authoritySql.execute(
              `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)`
            )
          ).ok
        ).toBe(true);
        expect(
          (
            await authoritySql.execute(
              `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
              ["item-1", "camera", 2]
            )
          ).ok
        ).toBe(true);

        const peerSession = await openSqlReplicationSession(
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
          { target: targetSession, peer: peerSession }
        );

        expect(sqlReplicationMode(baselineApply)).toBe("snapshot");
        expect(sqlReplicationBytes(baselineApply).snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica sees baseline SQL row", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return query.ok && query.data.rowCount === 1;
        });

        expect(
          (
            await replicaSql.execute(
              `UPDATE ${tableName} SET name = ?, quantity = ? WHERE id = ?`,
              ["replica-local", 9, "item-1"]
            )
          ).ok
        ).toBe(true);

        expect(
          (
            await authoritySql.execute(
              `UPDATE ${tableName} SET name = ?, quantity = ? WHERE id = ?`,
              ["authority-canonical", 4, "item-1"]
            )
          ).ok
        ).toBe(true);

        const fallbackApply = await reconcileSqlFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
            sinceSeq: baselineApply.appliedUntilSeq,
          },
          { target: targetSession, peer: peerSession }
        );

        expect(sqlReplicationMode(fallbackApply)).toBe("snapshot");
        expect(sqlReplicationBytes(fallbackApply).snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica falls back to authority snapshot", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return (
            query.ok &&
            query.data.rowCount === 1 &&
            query.data.rows[0][1] === "authority-canonical" &&
            query.data.rows[0][2] === 4
          );
        });

        const finalQuery = await replicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(finalQuery.ok).toBe(true);
        if (!finalQuery.ok) {
          throw new Error(finalQuery.error.message);
        }
        expect(finalQuery.data.rows[0]).toEqual([
          "item-1",
          "authority-canonical",
          4,
        ]);
      } finally {
        await cluster.stop();
      }
    }
  );
});
