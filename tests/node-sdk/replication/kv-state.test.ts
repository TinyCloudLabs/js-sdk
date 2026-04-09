import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  kvStateFromPeer,
  openKvReplicationSession,
  uniqueReplicationPrefix,
} from "./helpers";

function stateByKey(
  items: {
    key: string;
    status: "present" | "deleted" | "absent";
    seq?: number;
    invocationId?: string | null;
    deletedInvocationId?: string | null;
    valueHash?: string | null;
  }[]
) {
  return new Map(items.map((item) => [item.key, item]));
}

describe("Replication KV State", () => {
  test(
    "distinguishes present, deleted, and absent keys over an authenticated replication session",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-state");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/kv-state/${Date.now()}`;
        const presentKey = `${scope}/profile.json`;
        const deletedKey = `${scope}/deleted.json`;
        const absentKey = `${scope}/never-seen.json`;

        expect(
          await authority.kv.put(presentKey, {
            owner: "alice",
            kind: "present",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });

        expect(
          await authority.kv.put(deletedKey, {
            owner: "alice",
            kind: "deleted",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });

        expect(await authority.kv.delete(deletedKey)).toMatchObject({ ok: true });

        const session = await openKvReplicationSession(
          replica,
          authorityNode.url,
          scope
        );
        const response = await kvStateFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
            keys: [presentKey, deletedKey, absentKey],
          },
          session
        );

        expect(response.spaceId).toBe(authority.spaceId);
        expect(response.prefix).toBe(scope);
        expect(response.items).toHaveLength(3);

        const items = stateByKey(response.items);
        const present = items.get(presentKey);
        const deleted = items.get(deletedKey);
        const absent = items.get(absentKey);

        expect(present?.status).toBe("present");
        expect(present?.seq).toBeGreaterThan(0);
        expect(typeof present?.invocationId).toBe("string");
        expect(present?.deletedInvocationId ?? null).toBeNull();
        expect(typeof present?.valueHash).toBe("string");

        expect(deleted?.status).toBe("deleted");
        expect(deleted?.seq).toBeGreaterThan(0);
        expect(typeof deleted?.invocationId).toBe("string");
        expect(typeof deleted?.deletedInvocationId).toBe("string");
        expect(deleted?.valueHash ?? null).toBeNull();

        expect(absent?.status).toBe("absent");
        expect(absent?.seq ?? null).toBeNull();
        expect(absent?.invocationId ?? null).toBeNull();
        expect(absent?.deletedInvocationId ?? null).toBeNull();
        expect(absent?.valueHash ?? null).toBeNull();
      } finally {
        await cluster.stop();
      }
    }
  );
});
