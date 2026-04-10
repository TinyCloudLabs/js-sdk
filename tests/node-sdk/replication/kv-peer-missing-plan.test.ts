import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  peerMissingPlanFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function itemsByKey(
  items: {
    key: string;
    action: "keep" | "prune-delete" | "quarantine-absent";
    peerStatus: "present" | "deleted" | "absent";
  }[]
) {
  return new Map(items.map((item) => [item.key, item]));
}

describe("Replication Peer Missing Plan", () => {
  test(
    "classifies peer-missing outcomes as keep, prune-delete, and quarantine-absent",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("peer-missing-plan");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/peer-missing-plan/${Date.now()}`;
        const presentKey = `${scope}/present.json`;
        const deletedKey = `${scope}/deleted.json`;
        const localOnlyKey = `${scope}/local-only.json`;

        expect(await authority.kv.put(presentKey, { state: "present" })).toMatchObject({
          ok: true,
        });
        expect(
          await authority.kv.put(deletedKey, { state: "deleted-on-peer" })
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

        expect(firstPass.appliedEvents).toBeGreaterThan(0);
        await waitForCondition("replica has initial authority keys", async () => {
          const present = await replica.kv.get(presentKey);
          const deleted = await replica.kv.get(deletedKey);
          return present.ok && deleted.ok;
        });

        expect(await authority.kv.delete(deletedKey)).toMatchObject({ ok: true });
        expect(await replica.kv.put(localOnlyKey, { state: "local-only" })).toMatchObject({
          ok: true,
        });

        const plan = await peerMissingPlanFromPeer(
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

        expect(plan.spaceId).toBe(authority.spaceId);
        expect(plan.prefix).toBe(scope);
        expect(plan.peerUrl).toBe(authorityNode.url);
        expect(plan.peerHostRole).toBe(true);
        expect(plan.pruneDeleteCount).toBeGreaterThanOrEqual(1);
        expect(plan.quarantineAbsentCount).toBeGreaterThanOrEqual(1);
        expect(plan.keepCount).toBeGreaterThanOrEqual(1);

        const items = itemsByKey(plan.items);
        expect(items.get(presentKey)?.peerStatus).toBe("present");
        expect(items.get(presentKey)?.action).toBe("keep");
        expect(items.get(deletedKey)?.peerStatus).toBe("deleted");
        expect(items.get(deletedKey)?.action).toBe("prune-delete");
        expect(items.get(localOnlyKey)?.peerStatus).toBe("absent");
        expect(items.get(localOnlyKey)?.action).toBe("quarantine-absent");
      } finally {
        await cluster.stop();
      }
    }
  );

  test(
    "rejects authority-mode planning against a peer-serving replica that is not a host",
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
        const prefix = uniqueReplicationPrefix("peer-missing-host-only");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const host = createClusterClient(cluster, "node-b", prefix);
        const replica = createClusterClient(cluster, "node-c", prefix);
        const replicaNode = getClusterNode(cluster, "node-c");
        const hostNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await host.signIn();
        await replica.signIn();

        expect(host.spaceId).toBe(authority.spaceId);
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/peer-missing-host-only/${Date.now()}`;
        const key = `${scope}/profile.json`;
        expect(await replica.kv.put(key, { state: "replica-only" })).toMatchObject({
          ok: true,
        });

        let message = "";
        try {
          await peerMissingPlanFromPeer(
            cluster,
            "node-b",
            {
              peerUrl: replicaNode.url,
              spaceId: authority.spaceId!,
              prefix: scope,
            },
            {
              target: await openKvReplicationSession(host, hostNode.url, scope),
              peer: await openKvReplicationSession(replica, replicaNode.url, scope),
            }
          );
        } catch (error) {
          message = String(error);
        }

        expect(message).toContain("403");
        expect(message).toContain("host-role");
      } finally {
        await cluster.stop();
      }
    }
  );
});
