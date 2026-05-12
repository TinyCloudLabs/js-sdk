import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openSqlReplicationSession,
  openTransportSession,
  sqlReplicationBytes,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication SQL Peer Serving Enforcement", () => {
  test(
    "allows host SQL export and denies replica SQL export unless peer serving is enabled",
    { timeout: 600_000 },
    async () => {
      const prefix = uniqueReplicationPrefix("sql-peer-serving-default");
      const suffix = Date.now().toString(36);
      const dbName = `sql_peer_serving_${suffix}`;
      const tableName = `items_${suffix}`;

      const defaultCluster = await startCluster();
      try {
        const host = createClusterClient(defaultCluster, "node-b", prefix);
        const replica = createClusterClient(defaultCluster, "node-c", prefix);
        const hostNode = getClusterNode(defaultCluster, "node-b");
        const replicaNode = getClusterNode(defaultCluster, "node-c");

        const hostInfoResponse = await fetch(`${hostNode.url}/info`);
        const replicaInfoResponse = await fetch(`${replicaNode.url}/info`);
        expect(hostInfoResponse.ok).toBe(true);
        expect(replicaInfoResponse.ok).toBe(true);

        const hostInfo = (await hostInfoResponse.json()) as {
          rolesEnabled: string[];
          replication: { peerServing: boolean };
        };
        const replicaInfo = (await replicaInfoResponse.json()) as {
          rolesEnabled: string[];
          replication: { peerServing: boolean };
        };
        expect(hostInfo.rolesEnabled).toEqual(["host"]);
        expect(hostInfo.replication.peerServing).toBe(true);
        expect(replicaInfo.rolesEnabled).toEqual(["replica"]);
        expect(replicaInfo.replication.peerServing).toBe(false);

        await host.signIn();
        await replica.signIn();

        expect(host.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(host.spaceId);

        const hostSql = host.sql.db(dbName);
        expect(
          (await hostSql.execute(
            `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, label TEXT NOT NULL)`
          )).ok
        ).toBe(true);
        expect(
          (
            await hostSql.execute(
              `INSERT INTO ${tableName} (id, label) VALUES (?, ?)`,
              ["item-1", "host-export"]
            )
          ).ok
        ).toBe(true);

        const hostSession = await openSqlReplicationSession(host, hostNode.url, dbName);
        const hostTransport = await openTransportSession(hostSession);
        const hostExport = await fetch(`${hostNode.url}/replication/sql/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": hostTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: host.spaceId,
            dbName,
          }),
        });
        expect(hostExport.status).toBe(200);
        const hostExportBody = (await hostExport.json()) as {
          mode?: "snapshot" | "changeset";
          snapshotReason?: string | null;
          snapshot?: number[];
          changeset?: number[];
        };
        expect(hostExportBody.mode).toBe("snapshot");
        expect(hostExportBody.snapshotReason).toBe("initial-sync");
        expect(sqlReplicationBytes(hostExportBody).snapshotBytes).toBeGreaterThan(0);

        const replicaSql = replica.sql.db(dbName);
        expect(
          (await replicaSql.execute(
            `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, label TEXT NOT NULL)`
          )).ok
        ).toBe(true);
        expect(
          (
            await replicaSql.execute(
              `INSERT INTO ${tableName} (id, label) VALUES (?, ?)`,
              ["item-local", "replica-export"]
            )
          ).ok
        ).toBe(true);

        const replicaSession = await openSqlReplicationSession(
          replica,
          replicaNode.url,
          dbName
        );
        const replicaTransport = await openTransportSession(replicaSession);
        const replicaExport = await fetch(`${replicaNode.url}/replication/sql/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": replicaTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: replica.spaceId,
            dbName,
          }),
        });
        expect(replicaExport.status).toBe(403);
        expect(await replicaExport.text()).toContain("peerServing");
      } finally {
        await defaultCluster.stop();
      }

      const enabledCluster = await startCluster({
        nodes: [
          { name: "node-a", role: "authority", port: 8010 },
          { name: "node-b", role: "host", port: 8011 },
          {
            name: "node-c",
            role: "replica",
            port: 8012,
            env: {
              TINYCLOUD_REPLICATION_PEER_SERVING: "true",
            },
          },
        ],
      });
      try {
        const authority = createClusterClient(enabledCluster, "node-a", prefix);
        const replica = createClusterClient(enabledCluster, "node-c", prefix);
        const replicaNode = getClusterNode(enabledCluster, "node-c");

        const replicaInfoResponse = await fetch(`${replicaNode.url}/info`);
        expect(replicaInfoResponse.ok).toBe(true);
        const replicaInfo = (await replicaInfoResponse.json()) as {
          rolesEnabled: string[];
          replication: { peerServing: boolean };
        };
        expect(replicaInfo.rolesEnabled).toEqual(["replica"]);
        expect(replicaInfo.replication.peerServing).toBe(true);

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const replicaSql = replica.sql.db(dbName);
        expect(
          (await replicaSql.execute(
            `CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, label TEXT NOT NULL)`
          )).ok
        ).toBe(true);
        expect(
          (
            await replicaSql.execute(
              `INSERT INTO ${tableName} (id, label) VALUES (?, ?)`,
              ["item-local", "replica-export"]
            )
          ).ok
        ).toBe(true);

        const replicaSession = await openSqlReplicationSession(
          replica,
          replicaNode.url,
          dbName
        );
        const replicaTransport = await openTransportSession(replicaSession);
        const replicaExport = await fetch(`${replicaNode.url}/replication/sql/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": replicaTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: replica.spaceId,
            dbName,
          }),
        });
        expect(replicaExport.status).toBe(200);
        const replicaExportBody = (await replicaExport.json()) as {
          mode?: "snapshot" | "changeset";
          snapshot?: number[];
          changeset?: number[];
        };
        expect(sqlReplicationBytes(replicaExportBody).snapshotBytes).toBeGreaterThan(0);
      } finally {
        await enabledCluster.stop();
      }
    }
  );
});
