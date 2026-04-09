import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconSplitCompareFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function childStatusMap(
  children: {
    prefix: string;
    status: "match" | "local-missing" | "peer-missing" | "mismatch";
    localItemCount: number;
    peerItemCount: number;
  }[]
) {
  return new Map(children.map((child) => [child.prefix, child]));
}

describe("Replication KV Recon Split Compare", () => {
  test(
    "shows which child prefixes still need replay and converges after the remaining child is reconciled",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-split-compare");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-split-compare/${Date.now()}`;
        const primaryScope = `${scopeRoot}/primary`;
        const siblingScope = `${scopeRoot}/sibling`;
        const primaryProfileKey = `${primaryScope}/profile.json`;
        const primaryAssetKey = `${primaryScope}/assets/avatar.json`;
        const siblingProfileKey = `${siblingScope}/profile.json`;

        expect(
          await authority.kv.put(primaryProfileKey, {
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
          await authority.kv.put(siblingProfileKey, {
            owner: "alice",
            scope: "sibling",
            kind: "profile",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });

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
          const result = await replica.kv.get<{ scope: string }>(primaryProfileKey);
          return result.ok && result.data.data.scope === "primary";
        });

        const partialCompare = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, scopeRoot),
            peer: await openKvReplicationSession(authority, authorityNode.url, scopeRoot),
          }
        );

        const partialChildren = childStatusMap(partialCompare.children);
        expect(partialCompare.matches).toBe(false);
        expect(partialChildren.get(primaryScope)?.status).toBe("match");
        expect(partialChildren.get(primaryScope)?.localItemCount).toBe(2);
        expect(partialChildren.get(primaryScope)?.peerItemCount).toBe(2);
        expect(partialChildren.get(siblingScope)?.status).toBe("local-missing");
        expect(partialChildren.get(siblingScope)?.localItemCount).toBe(0);
        expect(partialChildren.get(siblingScope)?.peerItemCount).toBe(1);

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
          const result = await replica.kv.get<{ scope: string }>(siblingProfileKey);
          return result.ok && result.data.data.scope === "sibling";
        });

        const convergedCompare = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, scopeRoot),
            peer: await openKvReplicationSession(authority, authorityNode.url, scopeRoot),
          }
        );

        expect(convergedCompare.matches).toBe(true);
        expect(
          convergedCompare.children.every((child) => child.status === "match")
        ).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
