import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  notifyReplicationFromPeer,
  openKvReplicationSession,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

async function replicationNotificationsEnabled(nodeUrl: string): Promise<boolean> {
  const response = await fetch(`${nodeUrl}/replication/info`);
  if (!response.ok) {
    throw new Error(`Failed to load replication info from ${nodeUrl}: ${response.status}`);
  }
  const info = (await response.json()) as {
    capabilities?: { notifications?: boolean };
  };
  return info.capabilities?.notifications ?? false;
}

describe("Replication KV Warm Sync", () => {
  test(
    "uses authenticated notify long-poll to mark a KV scope dirty before reconcile",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-warm-sync");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        if (!(await replicationNotificationsEnabled(authorityNode.url))) {
          throw new Error("replication notifications are not enabled on the authority node");
        }

        const scope = `replication/kv-warm-sync/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const value = {
          owner: "alice",
          stage: "notify-warm-sync",
          createdAt: new Date().toISOString(),
        };

        const notifySession = await openKvReplicationSession(
          replica,
          authorityNode.url,
          scope
        );
        const notifyPromise = notifyReplicationFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            service: "kv",
            prefix: scope,
            lastSeenSeq: 0,
            timeoutMs: 30_000,
          },
          notifySession
        );

        expect(await authority.kv.put(key, value)).toMatchObject({ ok: true });

        const notification = await notifyPromise;
        expect(notification.spaceId).toBe(authority.spaceId!);
        expect(notification.service).toBe("kv");
        expect(notification.prefix).toBe(scope);
        expect(notification.dirty).toBe(true);
        expect(notification.timedOut).toBe(false);
        expect(notification.latestSeq).toBeGreaterThan(0);

        const reconcileResult = await reconcileFromPeer(
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

        expect(reconcileResult.appliedSequences).toBeGreaterThan(0);
        expect(reconcileResult.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("replica reconciles KV scope after notify", async () => {
          const result = await replica.kv.get<typeof value>(key);
          return result.ok && result.data.data.stage === value.stage;
        });

        const warmed = await replica.kv.get<typeof value>(key);
        expect(warmed.ok).toBe(true);
        if (!warmed.ok) {
          throw new Error(warmed.error.message);
        }
        expect(warmed.data.data).toEqual(value);
      } finally {
        await cluster.stop();
      }
    }
  );
});
