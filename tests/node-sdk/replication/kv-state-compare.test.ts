import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  kvStateCompareFromPeer,
  openKvReplicationSession,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function compareByKey(
  items: {
    key: string;
    kind: string;
    localInvocationId?: string | null;
    peerStatus: "present" | "deleted" | "absent";
    peerSeq?: number | null;
    peerInvocationId?: string | null;
    peerDeletedInvocationId?: string | null;
    peerValueHash?: string | null;
  }[]
) {
  return new Map(items.map((item) => [item.key, item]));
}

describe("Replication KV State Compare", () => {
  test(
    "compares local visible keys against peer state without pruning them",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-state-compare");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/kv-state-compare/${Date.now()}`;
        const presentKey = `${scope}/present.json`;
        const deletedKey = `${scope}/deleted.json`;
        const localOnlyKey = `${scope}/local-only.json`;

        expect(
          await authority.kv.put(presentKey, {
            owner: "alice",
            state: "present",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });
        expect(
          await authority.kv.put(deletedKey, {
            owner: "alice",
            state: "deleted-on-peer",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });

        const firstPass = await reconcileFromPeer(
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

        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("replica sees authority keys before divergence", async () => {
          const present = await replica.kv.get<{ state: string }>(presentKey);
          const deleted = await replica.kv.get<{ state: string }>(deletedKey);
          return (
            present.ok &&
            present.data.data.state === "present" &&
            deleted.ok &&
            deleted.data.data.state === "deleted-on-peer"
          );
        });

        expect(await authority.kv.delete(deletedKey)).toMatchObject({ ok: true });
        expect(
          await replica.kv.put(localOnlyKey, {
            owner: "bob",
            state: "local-only",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });

        const authorityLocalOnly = await authority.kv.get(localOnlyKey);
        expect(authorityLocalOnly.ok).toBe(false);
        if (authorityLocalOnly.ok) {
          throw new Error("expected authority host to miss the replica local-only key");
        }

        const compare = await kvStateCompareFromPeer(
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

        expect(compare.spaceId).toBe(authority.spaceId);
        expect(compare.prefix).toBe(scope);
        expect(compare.peerUrl).toBe(authorityNode.url);
        expect(compare.items.length).toBeGreaterThanOrEqual(3);

        const items = compareByKey(compare.items);
        const present = items.get(presentKey);
        const deleted = items.get(deletedKey);
        const localOnly = items.get(localOnlyKey);

        expect(present?.peerStatus).toBe("present");
        expect(typeof present?.localInvocationId).toBe("string");
        expect(typeof present?.peerInvocationId).toBe("string");
        expect(typeof present?.peerValueHash).toBe("string");

        expect(deleted?.peerStatus).toBe("deleted");
        expect(typeof deleted?.localInvocationId).toBe("string");
        expect(typeof deleted?.peerInvocationId).toBe("string");
        expect(typeof deleted?.peerDeletedInvocationId).toBe("string");
        expect(deleted?.peerValueHash ?? null).toBeNull();

        expect(localOnly?.peerStatus).toBe("absent");
        expect(typeof localOnly?.localInvocationId).toBe("string");
        expect(localOnly?.peerSeq ?? null).toBeNull();
        expect(localOnly?.peerInvocationId ?? null).toBeNull();
        expect(localOnly?.peerDeletedInvocationId ?? null).toBeNull();
        expect(localOnly?.peerValueHash ?? null).toBeNull();
      } finally {
        await cluster.stop();
      }
    }
  );
});
