import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconSplitFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function childMap(children: { prefix: string; fingerprint: string; itemCount: number }[]) {
  return new Map(children.map((child) => [child.prefix, child]));
}

describe("Replication KV Recon Split", () => {
  test(
    "summarizes immediate child scopes so partial replay can isolate the remaining mismatch",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-split");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-split/${Date.now()}`;
        const primaryScope = `${scopeRoot}/primary`;
        const siblingScope = `${scopeRoot}/sibling`;
        const primaryKey = `${primaryScope}/profile.json`;
        const primaryAssetKey = `${primaryScope}/assets/avatar.json`;
        const siblingKey = `${siblingScope}/profile.json`;

        expect(
          await authority.kv.put(primaryKey, {
            owner: "alice",
            scope: "primary",
            kind: "profile",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });
        expect(
          await authority.kv.put(primaryAssetKey, {
            owner: "alice",
            scope: "primary",
            kind: "asset",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });
        expect(
          await authority.kv.put(siblingKey, {
            owner: "alice",
            scope: "sibling",
            kind: "profile",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });

        const authorityBefore = await reconSplitFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          await openKvReplicationSession(authority, authorityNode.url, scopeRoot)
        );
        const replicaBefore = await reconSplitFromPeer(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          await openKvReplicationSession(replica, replicaNode.url, scopeRoot)
        );

        expect(authorityBefore.itemCount).toBe(3);
        expect(authorityBefore.children.map((child) => child.prefix)).toEqual([
          primaryScope,
          siblingScope,
        ]);
        expect(replicaBefore.itemCount).toBe(0);
        expect(replicaBefore.children).toEqual([]);

        const primaryReconcile = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, primaryScope),
            peer: await openKvReplicationSession(authority, authorityNode.url, primaryScope),
          }
        );
        expect(primaryReconcile.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("primary KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(primaryKey);
          return result.ok && result.data.data.scope === "primary";
        });

        const authorityPartial = await reconSplitFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          await openKvReplicationSession(authority, authorityNode.url, scopeRoot)
        );
        const replicaPartial = await reconSplitFromPeer(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          await openKvReplicationSession(replica, replicaNode.url, scopeRoot)
        );

        const authorityPartialChildren = childMap(authorityPartial.children);
        const replicaPartialChildren = childMap(replicaPartial.children);
        expect(replicaPartial.fingerprint).not.toBe(authorityPartial.fingerprint);
        expect(replicaPartialChildren.has(primaryScope)).toBe(true);
        expect(replicaPartialChildren.has(siblingScope)).toBe(false);
        expect(replicaPartialChildren.get(primaryScope)?.itemCount).toBe(2);
        expect(replicaPartialChildren.get(primaryScope)?.fingerprint).toBe(
          authorityPartialChildren.get(primaryScope)?.fingerprint
        );

        const siblingReconcile = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: siblingScope,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, siblingScope),
            peer: await openKvReplicationSession(authority, authorityNode.url, siblingScope),
          }
        );
        expect(siblingReconcile.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("sibling KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(siblingKey);
          return result.ok && result.data.data.scope === "sibling";
        });

        const authorityFinal = await reconSplitFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          await openKvReplicationSession(authority, authorityNode.url, scopeRoot)
        );
        const replicaFinal = await reconSplitFromPeer(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          await openKvReplicationSession(replica, replicaNode.url, scopeRoot)
        );

        expect(replicaFinal.itemCount).toBe(authorityFinal.itemCount);
        expect(replicaFinal.fingerprint).toBe(authorityFinal.fingerprint);
        expect(replicaFinal.children).toEqual(authorityFinal.children);
      } finally {
        await cluster.stop();
      }
    }
  );
});
