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

describe("Replication KV Offline Provisional", () => {
  test(
    "keeps a node-c authored KV write visible provisionally before later convergence",
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
        const prefix = uniqueReplicationPrefix("kv-offline-provisional");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authoringReplica = createClusterClient(cluster, "node-c", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");
        const authoringNode = getClusterNode(cluster, "node-c");

        await authority.signIn();
        await replica.signIn();
        await authoringReplica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);
        expect(authoringReplica.spaceId).toBe(authority.spaceId);

        const scope = `replication/kv-offline-provisional/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const initialValue = {
          owner: "alice",
          stage: "node-c-local",
          createdAt: new Date().toISOString(),
        };

        const writeResult = await authoringReplica.kv.put(key, initialValue);
        expect(writeResult.ok).toBe(true);

        const localCanonical = await authoringReplica.kv.get<typeof initialValue>(key);
        expect(localCanonical.ok).toBe(false);
        if (localCanonical.ok) {
          throw new Error("Expected canonical replica read to stay absent before reconcile");
        }
        expect(localCanonical.error.code).toBe("KV_NOT_FOUND");

        const localResult = await authoringReplica.kv.get<typeof initialValue>(key, {
          readMode: "provisional",
        });
        expect(localResult.ok).toBe(true);
        if (!localResult.ok) {
          throw new Error(localResult.error.message);
        }
        expect(localResult.data.data).toEqual(initialValue);

        const authorityBefore = await authority.kv.get(key);
        expect(authorityBefore.ok).toBe(false);
        if (authorityBefore.ok) {
          throw new Error("Expected node-a to miss the node-c-local write before reconcile");
        }
        expect(authorityBefore.error.code).toBe("KV_NOT_FOUND");

        const authorityReconcileSession = await openKvReplicationSession(
          authoringReplica,
          authoringNode.url,
          scope
        );
        const authorityTargetSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const firstPass = await reconcileFromPeer(cluster, "node-a", {
          peerUrl: authoringNode.url,
          spaceId: authority.spaceId!,
          prefix: scope,
        }, { target: authorityTargetSession, peer: authorityReconcileSession });

        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("node-a sees the node-c authored KV write", async () => {
          const result = await authority.kv.get<typeof initialValue>(key);
          return result.ok && result.data.data.stage === "node-c-local";
        });

        const authorityAfter = await authority.kv.get<typeof initialValue>(key);
        expect(authorityAfter.ok).toBe(true);
        if (!authorityAfter.ok) {
          throw new Error(authorityAfter.error.message);
        }
        expect(authorityAfter.data.data).toEqual(initialValue);

        const replicaReconcileSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const replicaTargetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scope
        );
        const secondPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          prefix: scope,
        }, { target: replicaTargetSession, peer: replicaReconcileSession });

        expect(secondPass.appliedSequences).toBeGreaterThan(0);
        expect(secondPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("node-b converges on the node-c authored KV write", async () => {
          const result = await replica.kv.get<typeof initialValue>(key);
          return result.ok && result.data.data.stage === "node-c-local";
        });

        const replicaAfter = await replica.kv.get<typeof initialValue>(key);
        expect(replicaAfter.ok).toBe(true);
        if (!replicaAfter.ok) {
          throw new Error(replicaAfter.error.message);
        }
        expect(replicaAfter.data.data).toEqual(initialValue);
      } finally {
        await cluster.stop();
      }
    }
  );
});
