import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  exportSqlFromPeer,
  openSqlReplicationSession,
  reconcileSqlFromPeer,
  sqlReplicationBytes,
  sqlReplicationMode,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication SQL Incremental Reconcile", () => {
  test(
    "uses a snapshot baseline and then accepts a later sinceSeq export for incremental SQL changes",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-incremental");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_incremental_${suffix}`;
        const tableName = `items_sql_incremental_${suffix}`;
        const authoritySql = authority.sql.db(dbName);
        const replicaSql = replica.sql.db(dbName);

        const createResult = await authoritySql.execute(
          `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)`
        );
        expect(createResult.ok).toBe(true);

        const firstInsert = await authoritySql.execute(
          `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
          ["item-1", "camera", 2]
        );
        expect(firstInsert.ok).toBe(true);

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

        expect(sqlReplicationMode(baselineApply)).toBe("snapshot");
        expect(sqlReplicationBytes(baselineApply).snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica sees baseline SQL row", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return query.ok && query.data.rowCount === 1;
        });

        const baselineSeq = baselineApply.appliedUntilSeq ?? 0;

        const updateResult = await authoritySql.execute(
          `UPDATE ${tableName} SET name = ?, quantity = ? WHERE id = ?`,
          ["camera-pro", 4, "item-1"]
        );
        expect(updateResult.ok).toBe(true);

        const secondInsert = await authoritySql.execute(
          `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
          ["item-2", "tripod", 1]
        );
        expect(secondInsert.ok).toBe(true);

        const incrementalExportResponse = await exportSqlFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            dbName,
            sinceSeq: baselineSeq,
          },
          exportSession
        );
        if (incrementalExportResponse.requestedSinceSeq !== undefined) {
          expect(incrementalExportResponse.requestedSinceSeq).toBe(baselineSeq);
        }
        const incrementalMode =
          incrementalExportResponse.mode ?? sqlReplicationMode(incrementalExportResponse);
        const incrementalBytes = sqlReplicationBytes(incrementalExportResponse);
        expect(
          incrementalBytes.changesetBytes + incrementalBytes.snapshotBytes
        ).toBeGreaterThan(0);
        if (incrementalMode === "changeset") {
          expect(incrementalBytes.changesetBytes).toBeGreaterThan(0);
        } else {
          expect(incrementalBytes.snapshotBytes).toBeGreaterThan(0);
        }

        const incrementalApply = await reconcileSqlFromPeer(
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

        expect(incrementalApply.appliedUntilSeq ?? baselineSeq).toBeGreaterThanOrEqual(
          baselineSeq
        );
        const incrementalApplyBytes = sqlReplicationBytes(incrementalApply);
        expect(
          incrementalApplyBytes.snapshotBytes + incrementalApplyBytes.changesetBytes
        ).toBeGreaterThan(0);

        await waitForCondition("replica sees incremental SQL changes", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id IN (?, ?) ORDER BY id`,
            ["item-1", "item-2"]
          );
          return (
            query.ok &&
            query.data.rowCount === 2 &&
            query.data.rows[0][1] === "camera-pro" &&
            query.data.rows[0][2] === 4 &&
            query.data.rows[1][1] === "tripod" &&
            query.data.rows[1][2] === 1
          );
        });

        const replicaQuery = await replicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} ORDER BY id`
        );
        expect(replicaQuery.ok).toBe(true);
        if (!replicaQuery.ok) {
          throw new Error(replicaQuery.error.message);
        }
        expect(replicaQuery.data.rowCount).toBe(2);
        expect(replicaQuery.data.rows).toEqual([
          ["item-1", "camera-pro", 4],
          ["item-2", "tripod", 1],
        ]);
      } finally {
        await cluster.stop();
      }
    }
  );
});
