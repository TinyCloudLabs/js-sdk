import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openAuthReplicationSession,
  openKvReplicationSession,
  openTransportSession,
  peerMissingPlanFromPeer,
  reconcileAuthFromPeer,
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

        await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: await openAuthReplicationSession(replica, replicaNode.url),
            peer: await openAuthReplicationSession(authority, authorityNode.url),
          }
        );

        const peerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const peerTransport = await openTransportSession(peerSession);
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
            peer: peerSession,
          }
        );

        expect(plan.spaceId).toBe(authority.spaceId);
        expect(plan.prefix).toBe(scope);
        expect(plan.peerUrl).toBe(authorityNode.url);
        expect(plan.peerServerDid).toBe(peerTransport?.serverDid);
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
    "requires the peer host delegation to be present in the local auth DAG",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("peer-missing-auth-dag");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const host = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const hostNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await host.signIn();

        expect(host.spaceId).toBe(authority.spaceId);

        const scope = `replication/peer-missing-auth-dag/${Date.now()}`;
        const key = `${scope}/profile.json`;
        expect(await host.kv.put(key, { state: "host-local-only" })).toMatchObject({
          ok: true,
        });

        let message = "";
        try {
          await peerMissingPlanFromPeer(
            cluster,
            "node-b",
            {
              peerUrl: authorityNode.url,
              spaceId: authority.spaceId!,
              prefix: scope,
            },
            {
              target: await openKvReplicationSession(host, hostNode.url, scope),
              peer: await openKvReplicationSession(authority, authorityNode.url, scope),
            }
          );
        } catch (error) {
          message = String(error);
        }

        expect(message).toContain("tinycloud.space/host");

        const authPull = await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: await openAuthReplicationSession(host, hostNode.url),
            peer: await openAuthReplicationSession(authority, authorityNode.url),
          }
        );

        expect(authPull.importedDelegations).toBeGreaterThanOrEqual(1);

        const peerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const peerTransport = await openTransportSession(peerSession);
        const plan = await peerMissingPlanFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(host, hostNode.url, scope),
            peer: peerSession,
          }
        );

        expect(plan.peerServerDid).toBe(peerTransport?.serverDid);
        expect(plan.peerHostRole).toBe(true);
        expect(plan.items.some((item) => item.key === key)).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
