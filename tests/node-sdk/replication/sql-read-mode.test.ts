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

describe("Replication SQL Read Mode", () => {
  test(
    "defaults SQL reads to canonical visibility and allows provisional reads until canonicalization converges",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster({
        nodes: [
          { name: "node-a", role: "authority", port: 8010 },
          { name: "node-b", role: "host", port: 8011 },
          {
            name: "node-c",
            role: "replica",
            port: 8012,
            env: { TINYCLOUD_REPLICATION_PEER_SERVING: "true" },
          },
        ],
      });
      try {
        const prefix = uniqueReplicationPrefix("sql-read-mode");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const canonicalReplica = createClusterClient(cluster, "node-c", prefix);
        const provisionalReplica = createClusterClient(
          cluster,
          "node-c",
          prefix,
          undefined,
          { sqlConfig: { readMode: "provisional" } }
        );
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-c");

        await authority.signIn();
        await canonicalReplica.signIn();
        await provisionalReplica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(canonicalReplica.spaceId).toBe(authority.spaceId);
        expect(provisionalReplica.spaceId).toBe(authority.spaceId);

        const suffix = Date.now();
        const dbName = `replication_sql_read_mode_${suffix}`;
        const tableName = `items_sql_read_mode_${suffix}`;
        const authoritySql = authority.sql.db(dbName);
        const canonicalReplicaSql = canonicalReplica.sql.db(dbName);
        const provisionalReplicaSql = provisionalReplica.sql.db(dbName);

        expect(
          (
            await authoritySql.execute(
              `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL)`
            )
          ).ok
        ).toBe(true);

        const baselineApply = await reconcileSqlFromPeer(
          cluster,
          "node-c",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
          },
          {
            target: await openSqlReplicationSession(canonicalReplica, replicaNode.url, dbName),
            peer: await openSqlReplicationSession(authority, authorityNode.url, dbName),
          }
        );
        expect(baselineApply.snapshotBytes ?? 0).toBeGreaterThan(0);

        await waitForCondition("replica sees canonical schema", async () => {
          const result = await canonicalReplicaSql.query(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
            [tableName]
          );
          return result.ok && result.data.rowCount === 1;
        });

        expect(
          (
            await canonicalReplicaSql.execute(
              `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
              ["item-local", "replica-camera", 1]
            )
          ).ok
        ).toBe(true);

        const canonicalBefore = await canonicalReplicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-local"]
        );
        expect(canonicalBefore.ok).toBe(true);
        if (!canonicalBefore.ok) {
          throw new Error(canonicalBefore.error.message);
        }
        expect(canonicalBefore.data.rowCount).toBe(0);

        const provisionalOverride = await canonicalReplicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-local"],
          { readMode: "provisional" }
        );
        expect(provisionalOverride.ok).toBe(true);
        if (!provisionalOverride.ok) {
          throw new Error(provisionalOverride.error.message);
        }
        expect(provisionalOverride.data.rows).toEqual([["item-local", "replica-camera", 1]]);

        const provisionalDefault = await provisionalReplicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-local"]
        );
        expect(provisionalDefault.ok).toBe(true);
        if (!provisionalDefault.ok) {
          throw new Error(provisionalDefault.error.message);
        }
        expect(provisionalDefault.data.rows).toEqual([["item-local", "replica-camera", 1]]);

        expect(
          (
            await authoritySql.execute(
              `INSERT INTO ${tableName} (id, name, quantity) VALUES (?, ?, ?)`,
              ["item-local", "replica-camera", 1]
            )
          ).ok
        ).toBe(true);

        const replicaCatchup = await reconcileSqlFromPeer(
          cluster,
          "node-c",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            dbName,
            sinceSeq: baselineApply.appliedUntilSeq,
          },
          {
            target: await openSqlReplicationSession(canonicalReplica, replicaNode.url, dbName),
            peer: await openSqlReplicationSession(authority, authorityNode.url, dbName),
          }
        );
        expect(
          (replicaCatchup.snapshotBytes ?? 0) + (replicaCatchup.changesetBytes ?? 0)
        ).toBeGreaterThan(0);

        await waitForCondition("canonical SQL view converges after authority round-trip", async () => {
          const result = await canonicalReplicaSql.query(
            `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
            ["item-local"]
          );
          return result.ok && result.data.rowCount === 1;
        });

        const canonicalAfter = await canonicalReplicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-local"]
        );
        expect(canonicalAfter.ok).toBe(true);
        if (!canonicalAfter.ok) {
          throw new Error(canonicalAfter.error.message);
        }
        expect(canonicalAfter.data.rows).toEqual([["item-local", "replica-camera", 1]]);

        const provisionalAfter = await canonicalReplicaSql.query(
          `SELECT id, name, quantity FROM ${tableName} WHERE id = ?`,
          ["item-local"],
          { readMode: "provisional" }
        );
        expect(provisionalAfter.ok).toBe(true);
        if (!provisionalAfter.ok) {
          throw new Error(provisionalAfter.error.message);
        }
        expect(provisionalAfter.data.rows).toEqual([["item-local", "replica-camera", 1]]);
      } finally {
        await cluster.stop();
      }
    }
  );
});
