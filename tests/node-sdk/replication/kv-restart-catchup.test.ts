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

describe("Replication KV Restart Catch-up", () => {
  test(
    "catches up a restarted node after writes land while it is offline",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-restart-catchup");
        const writer = createClusterClient(cluster, "node-a", prefix);
        const reader = createClusterClient(cluster, "node-b", prefix);
        const writerNode = getClusterNode(cluster, "node-a");

        await writer.signIn();
        await reader.signIn();

        expect(writer.spaceId).toBeDefined();
        expect(reader.spaceId).toBe(writer.spaceId);

        const scope = `replication/kv-restart-catchup/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const initialValue = {
          owner: "alice",
          stage: "before-restart",
          createdAt: new Date().toISOString(),
        };
        const updatedValue = {
          owner: "alice",
          stage: "after-restart",
          updatedAt: new Date().toISOString(),
        };

        const firstWrite = await writer.kv.put(key, initialValue);
        expect(firstWrite.ok).toBe(true);

        const initialReconcileSession = await openKvReplicationSession(
          writer,
          writerNode.url,
          scope
        );
        const firstPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: writerNode.url,
          spaceId: writer.spaceId!,
          prefix: scope,
        }, initialReconcileSession);

        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        const beforeRestart = await reader.kv.get<typeof initialValue>(key);
        expect(beforeRestart.ok).toBe(true);
        if (!beforeRestart.ok) {
          throw new Error(beforeRestart.error.message);
        }
        expect(beforeRestart.data.data).toEqual(initialValue);

        await cluster.stopNode("node-b");

        const secondWrite = await writer.kv.put(key, updatedValue);
        expect(secondWrite.ok).toBe(true);

        await cluster.startNode("node-b");

        const restartedReader = createClusterClient(cluster, "node-b", prefix);
        await restartedReader.signIn();
        expect(restartedReader.spaceId).toBe(writer.spaceId);

        const persistedResult = await restartedReader.kv.get<typeof initialValue>(key);
        expect(persistedResult.ok).toBe(true);
        if (!persistedResult.ok) {
          throw new Error(persistedResult.error.message);
        }
        expect(persistedResult.data.data).toEqual(initialValue);

        const restartedReconcileSession = await openKvReplicationSession(
          writer,
          writerNode.url,
          scope
        );
        const secondPass = await reconcileFromPeer(cluster, "node-b", {
          peerUrl: writerNode.url,
          spaceId: writer.spaceId!,
          prefix: scope,
          sinceSeq: firstPass.appliedUntilSeq,
        }, restartedReconcileSession);

        expect(secondPass.appliedSequences).toBeGreaterThan(0);
        expect(secondPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("updated KV available on restarted node-b", async () => {
          const result = await restartedReader.kv.get<typeof updatedValue>(key);
          return result.ok && result.data.data.stage === "after-restart";
        });

        const restartedResult = await restartedReader.kv.get<typeof updatedValue>(key);
        expect(restartedResult.ok).toBe(true);
        if (!restartedResult.ok) {
          throw new Error(restartedResult.error.message);
        }
        expect(restartedResult.data.data).toEqual(updatedValue);
      } finally {
        await cluster.stop();
      }
    }
  );
});
