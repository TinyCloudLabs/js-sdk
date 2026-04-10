import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  peerMissingApplyFromPeer,
  peerMissingQuarantineFromLocal,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function quarantineKeys(items: { key: string }[]) {
  return new Set(items.map((item) => item.key));
}

describe("Replication Peer Missing Quarantine", () => {
  test(
    "lists quarantined keys and clears them after keep and prune-delete resolution",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("peer-missing-quarantine");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/peer-missing-quarantine/${Date.now()}`;
        const keepKey = `${scope}/keep.json`;
        const pruneKey = `${scope}/prune.json`;

        expect(await replica.kv.put(keepKey, { state: "local-only-keep" })).toMatchObject({
          ok: true,
        });
        expect(await replica.kv.put(pruneKey, { state: "local-only-prune" })).toMatchObject({
          ok: true,
        });

        const firstApply = await peerMissingApplyFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, scope),
            peer: await openKvReplicationSession(authority, authorityNode.url, scope),
          }
        );

        expect(firstApply.quarantined).toBeGreaterThanOrEqual(2);
        expect(firstApply.clearedQuarantine).toBe(0);

        const quarantineBefore = await peerMissingQuarantineFromLocal(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          await openKvReplicationSession(replica, replicaNode.url, scope)
        );

        const beforeKeys = quarantineKeys(quarantineBefore.items);
        expect(beforeKeys.has(keepKey)).toBe(true);
        expect(beforeKeys.has(pruneKey)).toBe(true);

        const authorityPull = await reconcileFromPeer(
          cluster,
          "node-a",
          {
            peerUrl: replicaNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(authority, authorityNode.url, scope),
            peer: await openKvReplicationSession(replica, replicaNode.url, scope),
          }
        );

        expect(authorityPull.appliedEvents).toBeGreaterThan(0);
        await waitForCondition("authority now sees replica-authored keys", async () => {
          const keep = await authority.kv.get(keepKey);
          const prune = await authority.kv.get(pruneKey);
          return keep.ok && prune.ok;
        });

        expect(await authority.kv.delete(pruneKey)).toMatchObject({ ok: true });

        const secondApply = await peerMissingApplyFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, scope),
            peer: await openKvReplicationSession(authority, authorityNode.url, scope),
          }
        );

        expect(secondApply.kept).toBeGreaterThanOrEqual(1);
        expect(secondApply.prunedDeletes).toBeGreaterThanOrEqual(1);
        expect(secondApply.clearedQuarantine).toBeGreaterThanOrEqual(2);

        const appliedItems = new Map(
          secondApply.items.map((item) => [item.key, item])
        );
        expect(appliedItems.get(keepKey)?.action).toBe("keep");
        expect(appliedItems.get(keepKey)?.clearedQuarantine).toBe(true);
        expect(appliedItems.get(pruneKey)?.action).toBe("prune-delete");
        expect(appliedItems.get(pruneKey)?.clearedQuarantine).toBe(true);

        await waitForCondition("replica no longer serves prune key", async () => {
          const result = await replica.kv.get(pruneKey);
          return !result.ok;
        });

        const keepResult = await replica.kv.get<{ state: string }>(keepKey);
        expect(keepResult.ok).toBe(true);

        const quarantineAfter = await peerMissingQuarantineFromLocal(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          await openKvReplicationSession(replica, replicaNode.url, scope)
        );

        expect(quarantineAfter.items).toHaveLength(0);
      } finally {
        await cluster.stop();
      }
    }
  );
});
