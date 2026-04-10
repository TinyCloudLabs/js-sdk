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

describe("Replication SQL Restart Cursor", () => {
  test(
    "persists the SQL peer cursor across node restart and resumes with an incremental changeset",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-restart-cursor");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_restart_cursor_${suffix}`;
        const tableName = `items_sql_restart_cursor_${suffix}`;
        const authoritySql = authority.sql.db(dbName);

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

        const baselinePeerSession = await openSqlReplicationSession(
          authority,
          authorityNode.url,
          dbName
        );
        const baselineTargetSession = await openSqlReplicationSession(
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
          { target: baselineTargetSession, peer: baselinePeerSession }
        );

        expect(sqlReplicationMode(baselineApply)).toBe("snapshot");
        expect(sqlReplicationBytes(baselineApply).snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica sees baseline SQL row", async () => {
          const query = await replica.sql.db(dbName).query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return query.ok && query.data.rowCount === 1;
        });

        await cluster.stopNode("node-b");

        expect(
          (
            await authoritySql.execute(
              `UPDATE ${tableName} SET name = ?, quantity = ? WHERE id = ?`,
              ["camera-pro", 4, "item-1"]
            )
          ).ok
        ).toBe(true);
        expect(
          (
            await authoritySql.execute(
              `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
              ["item-2", "tripod", 1]
            )
          ).ok
        ).toBe(true);

        await cluster.startNode("node-b");

        const restartedReplica = createClusterClient(cluster, "node-b", prefix);
        await restartedReplica.signIn();
        expect(restartedReplica.spaceId).toBe(authority.spaceId);

        const peerSession = await openSqlReplicationSession(
          authority,
          authorityNode.url,
          dbName
        );
        const targetSession = await openSqlReplicationSession(
          restartedReplica,
          replicaNode.url,
          dbName
        );

        const resumedApply = await reconcileSqlFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
          },
          { target: targetSession, peer: peerSession }
        );

        expect(sqlReplicationMode(resumedApply)).toBe("changeset");
        expect(sqlReplicationBytes(resumedApply).changesetBytes).toBeGreaterThan(0);
        expect(sqlReplicationBytes(resumedApply).snapshotBytes).toBe(0);
        expect(resumedApply.appliedUntilSeq).toBeGreaterThan(
          baselineApply.appliedUntilSeq ?? 0
        );

        await waitForCondition(
          "restarted replica catches up using incremental SQL changeset",
          async () => {
            const query = await restartedReplica.sql.db(dbName).query(
              `SELECT id, name, quantity FROM ${tableName} ORDER BY id`
            );
            return (
              query.ok &&
              query.data.rowCount === 2 &&
              query.data.rows[0][1] === "camera-pro" &&
              query.data.rows[0][2] === 4 &&
              query.data.rows[1][1] === "tripod" &&
              query.data.rows[1][2] === 1
            );
          }
        );
      } finally {
        await cluster.stop();
      }
    }
  );
});
