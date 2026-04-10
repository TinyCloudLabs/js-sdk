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

describe("Replication SQL Peer Serving Reconcile", () => {
  test(
    "pulls SQL changes through a peer-serving replica into a host",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster({
        nodes: [
          { name: "node-a", role: "authority", port: 8210 },
          { name: "node-b", role: "host", port: 8211 },
          {
            name: "node-c",
            role: "replica",
            port: 8212,
            env: {
              TINYCLOUD_REPLICATION_PEER_SERVING: "true",
            },
          },
        ],
      });
      try {
        const prefix = uniqueReplicationPrefix("sql-peer-serving-reconcile");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const host = createClusterClient(cluster, "node-b", prefix);
        const replica = createClusterClient(cluster, "node-c", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const hostNode = getClusterNode(cluster, "node-b");
        const replicaNode = getClusterNode(cluster, "node-c");

        await authority.signIn();
        await host.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(host.spaceId).toBe(authority.spaceId);
        expect(replica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_peer_serving_reconcile_${suffix}`;
        const tableName = `items_sql_peer_serving_reconcile_${suffix}`;
        const authoritySql = authority.sql.db(dbName);
        const hostSql = host.sql.db(dbName);
        const replicaSql = replica.sql.db(dbName);

        expect(
          (
            await authoritySql.execute(
              `CREATE TABLE IF NOT EXISTS ${tableName} (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL
              )`
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

        const seedReplicaApply = await reconcileSqlFromPeer(
          cluster,
          "node-c",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
          },
          {
            target: await openSqlReplicationSession(replica, replicaNode.url, dbName),
            peer: await openSqlReplicationSession(authority, authorityNode.url, dbName),
          }
        );

        expect(
          sqlReplicationBytes(seedReplicaApply).snapshotBytes +
            sqlReplicationBytes(seedReplicaApply).changesetBytes
        ).toBeGreaterThan(0);

        await waitForCondition("peer-serving replica sees baseline SQL row", async () => {
          const query = await replicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return query.ok && query.data.rowCount === 1;
        });

        expect(
          (
            await authoritySql.execute(
              `UPDATE ${tableName} SET name = ?, quantity = ? WHERE id = ?`,
              ["camera-pro", 4, "item-1"]
            )
          ).ok
        ).toBe(true);

        const seedReplicaUpdate = await reconcileSqlFromPeer(
          cluster,
          "node-c",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
            sinceSeq: seedReplicaApply.appliedUntilSeq,
          },
          {
            target: await openSqlReplicationSession(replica, replicaNode.url, dbName),
            peer: await openSqlReplicationSession(authority, authorityNode.url, dbName),
          }
        );

        expect(seedReplicaUpdate.appliedUntilSeq).toBeGreaterThan(
          seedReplicaApply.appliedUntilSeq ?? 0
        );

        await waitForCondition(
          "peer-serving replica sees updated SQL row before relaying it",
          async () => {
            const query = await replicaSql.query(
              `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
              ["item-1"]
            );
            return (
              query.ok &&
              query.data.rowCount === 1 &&
              query.data.rows[0][1] === "camera-pro" &&
              query.data.rows[0][2] === 4
            );
          }
        );

        const hostApply = await reconcileSqlFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: replicaNode.url,
            spaceId: authority.spaceId!,
            dbName,
          },
          {
            target: await openSqlReplicationSession(host, hostNode.url, dbName),
            peer: await openSqlReplicationSession(replica, replicaNode.url, dbName),
          }
        );

        expect(
          sqlReplicationBytes(hostApply).snapshotBytes +
            sqlReplicationBytes(hostApply).changesetBytes
        ).toBeGreaterThan(0);

        await waitForCondition("host catches SQL changes through the replica", async () => {
          const query = await hostSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-1"]
          );
          return (
            query.ok &&
            query.data.rowCount === 1 &&
            query.data.rows[0][1] === "camera-pro" &&
            query.data.rows[0][2] === 4
          );
        });

        const hostQuery = await hostSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-1"]
        );
        expect(hostQuery.ok).toBe(true);
        if (!hostQuery.ok) {
          throw new Error(hostQuery.error.message);
        }
        expect(hostQuery.data.rows[0]).toEqual(["item-1", "camera-pro", 4]);
      } finally {
        await cluster.stop();
      }
    }
  );
});
