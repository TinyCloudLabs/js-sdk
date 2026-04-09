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

describe("Replication KV Peer Serving Reconcile", () => {
  test(
    "pulls a real KV value through node-b into node-c",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-peer-serving-reconcile");
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

        const scope = `replication/kv-peer-serving-reconcile/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const value = {
          owner: "alice",
          relayedBy: "node-b",
          createdAt: new Date().toISOString(),
        };

        const putResult = await authority.kv.put(key, value);
        expect(putResult.ok).toBe(true);

        const hostReconcileSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const hostTargetSession = await openKvReplicationSession(
          host,
          hostNode.url,
          scope
        );
        const firstPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          prefix: scope,
        }, { target: hostTargetSession, peer: hostReconcileSession });
        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        const replicaReconcileSession = await openKvReplicationSession(
          host,
          hostNode.url,
          scope
        );
        const replicaTargetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scope
        );
        const secondPass = await reconcileFromPeer(cluster, "node-c", {
          peerUrl: hostNode.url,
          spaceId: authority.spaceId!,
          prefix: scope,
        }, { target: replicaTargetSession, peer: replicaReconcileSession });
        expect(secondPass.appliedSequences).toBeGreaterThan(0);
        expect(secondPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("replicated KV available on node-c", async () => {
          const getResult = await replica.kv.get<typeof value>(key);
          return getResult.ok;
        });

        const replicaGet = await replica.kv.get<typeof value>(key);
        expect(replicaGet.ok).toBe(true);
        if (!replicaGet.ok) {
          throw new Error(replicaGet.error.message);
        }
        expect(replicaGet.data.data).toEqual(value);
      } finally {
        await cluster.stop();
      }
    }
  );
});
