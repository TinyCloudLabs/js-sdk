import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  exportFromPeer,
  getClusterNode,
  openKvReplicationSession,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication KV Reconcile", () => {
  test(
    "pulls real KV data from one live node into another live node",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-reconcile");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/kv-reconcile/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const value = {
          owner: "alice",
          replicatedTo: "node-b",
          createdAt: new Date().toISOString(),
        };

        const putResult = await authority.kv.put(key, value);
        expect(putResult.ok).toBe(true);

        const exportSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const exportResult = await exportFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          exportSession
        );
        expect(exportResult.spaceId).toBe(authority.spaceId);
        expect(exportResult.prefix).toBe(scope);
        expect(exportResult.sequences.length).toBeGreaterThan(0);

        const firstPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          prefix: scope,
        }, exportSession);

        expect(firstPass.spaceId).toBe(authority.spaceId);
        expect(firstPass.peerUrl).toBe(authorityNode.url);
        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("replicated KV available on node-b", async () => {
          const getResult = await replica.kv.get<typeof value>(key);
          return getResult.ok;
        });

        const replicaGet = await replica.kv.get<typeof value>(key);
        expect(replicaGet.ok).toBe(true);
        if (!replicaGet.ok) {
          throw new Error(replicaGet.error.message);
        }
        expect(replicaGet.data.data).toEqual(value);

        const replicaList = await replica.kv.list({ prefix: scope });
        expect(replicaList.ok).toBe(true);
        if (!replicaList.ok) {
          throw new Error(replicaList.error.message);
        }
        expect(replicaList.data.keys).toContain(key);

        const secondPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: authorityNode.url,
          spaceId: authority.spaceId!,
          prefix: scope,
          sinceSeq: firstPass.appliedUntilSeq,
        }, exportSession);

        expect(secondPass.appliedSequences).toBe(0);
        expect(secondPass.appliedEvents).toBe(0);
      } finally {
        await cluster.stop();
      }
    }
  );
});
