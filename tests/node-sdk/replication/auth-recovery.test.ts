import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication Auth Recovery", () => {
  test(
    "preserves a node-c authored KV write during authority outage and converges after reconnect",
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
            env: {
              TINYCLOUD_REPLICATION_PEER_SERVING: "true",
            },
          },
        ],
      });
      try {
        const prefix = uniqueReplicationPrefix("auth-recovery");
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

        const scope = `replication/auth-recovery/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const initialValue = {
          owner: "alice",
          stage: "node-c-offline",
          createdAt: new Date().toISOString(),
        };

        await cluster.stopNode("node-a");

        const offlineWrite = await replica.kv.put(key, initialValue);
        expect(offlineWrite.ok).toBe(true);

        const localReplicaValue = await replica.kv.get<typeof initialValue>(key);
        expect(localReplicaValue.ok).toBe(true);
        if (!localReplicaValue.ok) {
          throw new Error(localReplicaValue.error.message);
        }
        expect(localReplicaValue.data.data).toEqual(initialValue);

        const hostBeforeRecovery = await host.kv.get(key);
        expect(hostBeforeRecovery.ok).toBe(false);
        if (hostBeforeRecovery.ok) {
          throw new Error("Expected node-b to miss the offline-authored write before recovery");
        }
        expect(hostBeforeRecovery.error.code).toBe("KV_NOT_FOUND");

        const restartedAuthority = await cluster.startNode("node-a");
        expect(restartedAuthority.name).toBe("node-a");

        const authorityAfterRestart = createClusterClient(cluster, "node-a", prefix);
        await authorityAfterRestart.signIn();
        expect(authorityAfterRestart.spaceId).toBe(authority.spaceId);

        const nodeCToAuthority = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scope
        );
        const authorityTargetSession = await openKvReplicationSession(
          authorityAfterRestart,
          authorityNode.url,
          scope
        );
        const recoverToAuthority = await reconcileFromPeer(
          cluster,
          "node-a",
          {
            peerUrl: replicaNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          { target: authorityTargetSession, peer: nodeCToAuthority }
        );

        expect(recoverToAuthority.appliedSequences).toBeGreaterThan(0);
        expect(recoverToAuthority.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("authority converges on node-c authored KV write", async () => {
          const result = await authorityAfterRestart.kv.get<typeof initialValue>(key);
          return result.ok && result.data.data.stage === "node-c-offline";
        });

        const authorityRecovered = await authorityAfterRestart.kv.get<typeof initialValue>(key);
        expect(authorityRecovered.ok).toBe(true);
        if (!authorityRecovered.ok) {
          throw new Error(authorityRecovered.error.message);
        }
        expect(authorityRecovered.data.data).toEqual(initialValue);

        const authorityToHost = await openKvReplicationSession(
          authorityAfterRestart,
          authorityNode.url,
          scope
        );
        const hostTargetSession = await openKvReplicationSession(
          host,
          hostNode.url,
          scope
        );
        const recoverToHost = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          { target: hostTargetSession, peer: authorityToHost }
        );

        expect(recoverToHost.appliedSequences).toBeGreaterThan(0);
        expect(recoverToHost.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("host converges after authority recovery", async () => {
          const result = await host.kv.get<typeof initialValue>(key);
          return result.ok && result.data.data.stage === "node-c-offline";
        });

        const hostRecovered = await host.kv.get<typeof initialValue>(key);
        expect(hostRecovered.ok).toBe(true);
        if (!hostRecovered.ok) {
          throw new Error(hostRecovered.error.message);
        }
        expect(hostRecovered.data.data).toEqual(initialValue);
      } finally {
        await cluster.stop();
      }
    }
  );
});
