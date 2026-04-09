import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Cluster Smoke", () => {
  test(
    "boots three nodes and exposes /info",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        expect(cluster.nodes).toHaveLength(3);

        for (const node of cluster.nodes) {
          const response = await fetch(`${node.url}/info`);
          const replicationResponse = await fetch(`${node.url}/replication/info`);
          expect(response.ok).toBe(true);
          expect(replicationResponse.ok).toBe(true);

          const info = await response.json();
          const replication = await replicationResponse.json();
          expect(typeof info.version).toBe("string");
          expect(Array.isArray(info.features)).toBe(true);
          expect(info.features).toContain("replication");
          expect(info.rolesSupported).toContain("host");
          expect(info.rolesSupported).toContain("replica");
          expect(info.rolesEnabled).toEqual([
            node.role === "replica" ? "replica" : "host",
          ]);
          expect(info.services).toMatchObject({
            kv: true,
            delegation: true,
            sharing: true,
            sql: true,
            duckdb: true,
          });
          expect(info.replication).toMatchObject({
            supported: true,
            enabled: true,
            peerServing: node.role === "replica" ? false : true,
            recon: false,
            authSync: false,
            authoredFactExchange: true,
            notifications: false,
            snapshots: false,
          });
          expect(replication).toMatchObject({
            routeMounted: true,
            protocolReady: true,
            requiresAuth: true,
            capabilities: {
              supported: true,
              enabled: true,
              peerServing: node.role === "replica" ? false : true,
              recon: false,
              authSync: false,
              authoredFactExchange: true,
              notifications: false,
              snapshots: false,
            },
          });
          expect(Array.isArray(replication.endpoints)).toBe(true);
          expect(replication.endpoints).toContain("GET /replication/info");
          expect(replication.endpoints).toContain(
            "POST /replication/session/open"
          );
          expect(replication.endpoints).toContain("POST /replication/export");
          expect(replication.endpoints).toContain(
            "POST /replication/reconcile"
          );
          expect(replication.endpoints).toContain(
            "POST /replication/sql/export"
          );
          expect(replication.endpoints).toContain(
            "POST /replication/sql/reconcile"
          );
        }
      } finally {
        await cluster.stop();
      }
    }
  );

  test(
    "same user and prefix map to the same space across hosts",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("same-space");
        const aliceOnAuthority = createClusterClient(cluster, "node-a", prefix);
        const aliceOnHost = createClusterClient(cluster, "node-b", prefix);

        await aliceOnAuthority.signIn();
        await aliceOnHost.signIn();

        expect(aliceOnAuthority.spaceId).toBeDefined();
        expect(aliceOnHost.spaceId).toBeDefined();
        expect(aliceOnAuthority.spaceId).toBe(aliceOnHost.spaceId);
      } finally {
        await cluster.stop();
      }
    }
  );
});
