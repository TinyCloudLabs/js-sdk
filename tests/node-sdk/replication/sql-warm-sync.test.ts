import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  notifyReplicationFromPeer,
  openSqlReplicationSession,
  reconcileSqlFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

async function replicationNotificationsEnabled(nodeUrl: string): Promise<boolean> {
  const response = await fetch(`${nodeUrl}/replication/info`);
  if (!response.ok) {
    throw new Error(`Failed to load replication info from ${nodeUrl}: ${response.status}`);
  }
  const info = (await response.json()) as {
    capabilities?: { notifications?: boolean };
  };
  return info.capabilities?.notifications ?? false;
}

describe("Replication SQL Warm Sync", () => {
  test(
    "uses authenticated notify long-poll to mark a SQL database dirty before reconcile",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("sql-warm-sync");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        if (!(await replicationNotificationsEnabled(authorityNode.url))) {
          throw new Error("replication notifications are not enabled on the authority node");
        }

        const suffix = Date.now().toString(36);
        const dbName = `warm_sync_sql_${suffix}`;
        const tableName = `items_${suffix}`;
        const sql = authority.sql.db(dbName);
        const replicaSql = replica.sql.db(dbName);

        await sql.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, label TEXT)`);

        const notifySession = await openSqlReplicationSession(
          replica,
          authorityNode.url,
          dbName
        );
        const baselineNotification = await notifyReplicationFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            service: "sql",
            dbName,
            lastSeenSeq: 0,
            timeoutMs: 100,
          },
          notifySession
        );
        expect(baselineNotification.dirty).toBe(true);
        expect(baselineNotification.latestSeq).toBeGreaterThan(0);
        const notifyPromise = notifyReplicationFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            service: "sql",
            dbName,
            lastSeenSeq: baselineNotification.latestSeq,
            timeoutMs: 30_000,
          },
          notifySession
        );

        await sql.execute(`INSERT INTO ${tableName} (id, label) VALUES (?, ?)`, [
          1,
          "notify-warm-sync",
        ]);

        const notification = await notifyPromise;
        expect(notification.spaceId).toBe(authority.spaceId!);
        expect(notification.service).toBe("sql");
        expect(notification.dbName).toBe(dbName);
        expect(notification.dirty).toBe(true);
        expect(notification.timedOut).toBe(false);
        expect(notification.latestSeq).toBeGreaterThan(0);

        const reconcileResult = await reconcileSqlFromPeer(
          cluster,
          "node-b",
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

        expect(reconcileResult.snapshotBytes).toBeGreaterThan(0);

        await waitForCondition("replica reconciles SQL database after notify", async () => {
          const result = await replicaSql.query<{ id: number; label: string }>(
            `SELECT id, label FROM ${tableName} WHERE id = ?`,
            [1]
          );
          return result.ok && result.data.rows[0]?.[1] === "notify-warm-sync";
        });

        const warmed = await replicaSql.query<{ id: number; label: string }>(
          `SELECT id, label FROM ${tableName} WHERE id = ?`,
          [1]
        );
        expect(warmed.ok).toBe(true);
        if (!warmed.ok) {
          throw new Error(warmed.error.message);
        }
        expect(warmed.data.rows[0]?.[1]).toBe("notify-warm-sync");
      } finally {
        await cluster.stop();
      }
    }
  );
});
