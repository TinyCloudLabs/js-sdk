import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconcileFromPeer,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication KV Delete Reconcile", () => {
  test(
    "pulls a real KV delete from one live node into another live node",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-delete-reconcile");
        const writer = createClusterClient(cluster, "node-a", prefix);
        const reader = createClusterClient(cluster, "node-b", prefix);
        const writerNode = cluster.nodes.find((node) => node.name === "node-a");
        if (!writerNode) {
          throw new Error("node-a missing from cluster");
        }

        await writer.signIn();
        await reader.signIn();

        expect(writer.spaceId).toBeDefined();
        expect(reader.spaceId).toBe(writer.spaceId);

        const scope = `replication/kv-delete-reconcile/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const value = {
          owner: "alice",
          deletedBy: "node-a",
          createdAt: new Date().toISOString(),
        };

        const putResult = await writer.kv.put(key, value);
        expect(putResult.ok).toBe(true);

        const reconcileSession = await openKvReplicationSession(
          writer,
          writerNode.url,
          scope
        );
        const firstPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: writerNode.url,
          spaceId: writer.spaceId!,
          prefix: scope,
        }, reconcileSession);

        expect(firstPass.spaceId).toBe(writer.spaceId);
        expect(firstPass.peerUrl).toBe(writerNode.url);
        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        const replicatedGet = await reader.kv.get<typeof value>(key);
        expect(replicatedGet.ok).toBe(true);
        if (!replicatedGet.ok) {
          throw new Error(replicatedGet.error.message);
        }
        expect(replicatedGet.data.data).toEqual(value);

        const deleteResult = await writer.kv.delete(key);
        expect(deleteResult.ok).toBe(true);

        const secondPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: writerNode.url,
          spaceId: writer.spaceId!,
          prefix: scope,
          sinceSeq: firstPass.appliedUntilSeq,
        }, reconcileSession);

        expect(secondPass.spaceId).toBe(writer.spaceId);
        expect(secondPass.peerUrl).toBe(writerNode.url);
        expect(secondPass.appliedSequences).toBeGreaterThan(0);
        expect(secondPass.appliedEvents).toBeGreaterThan(0);

        const deletedResult = await reader.kv.get(key);
        expect(deletedResult.ok).toBe(false);
        if (deletedResult.ok) {
          throw new Error("Expected deleted key lookup to fail on node-b");
        }
        expect(deletedResult.error.code).toBe("KV_NOT_FOUND");
      } finally {
        await cluster.stop();
      }
    }
  );
});
