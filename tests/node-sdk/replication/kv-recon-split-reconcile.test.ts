import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconSplitCompareFromPeer,
  reconcileFromPeer,
  reconcileSplitFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function splitChildMap(
  children: {
    prefix: string;
    beforeStatus: "match" | "local-missing" | "peer-missing" | "mismatch";
    afterStatus: "match" | "local-missing" | "peer-missing" | "mismatch";
    appliedSequences: number;
    appliedEvents: number;
  }[]
) {
  return new Map(children.map((child) => [child.prefix, child]));
}

describe("Replication KV Split-Driven Replay", () => {
  test(
    "replays only the remaining missing child after one child has already been reconciled",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-split-reconcile");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-split-reconcile/${Date.now()}`;
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
            target: await openKvReplicationSession(
              replica,
              replicaNode.url,
              primaryScope
            ),
            peer: await openKvReplicationSession(
              authority,
              authorityNode.url,
              primaryScope
            ),
          }
        );
        expect(primaryReconcile.appliedSequences).toBeGreaterThan(0);
        expect(primaryReconcile.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("primary KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(
            primaryProfileKey
          );
          return result.ok && result.data.data.scope === "primary";
        });

        const rootTargetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scopeRoot
        );
        const rootPeerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scopeRoot
        );

        const compareBefore = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );
        const compareBeforeChildren = splitChildMap(compareBefore.children);
        expect(compareBefore.matches).toBe(false);
        expect(compareBeforeChildren.get(primaryScope)?.status).toBe("match");
        expect(compareBeforeChildren.get(primaryScope)?.localItemCount).toBe(2);
        expect(compareBeforeChildren.get(primaryScope)?.peerItemCount).toBe(2);
        expect(compareBeforeChildren.get(siblingScope)?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(siblingScope)?.localItemCount).toBe(0);
        expect(compareBeforeChildren.get(siblingScope)?.peerItemCount).toBe(1);

        const splitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 10,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );

        expect(splitReconcile.spaceId).toBe(authority.spaceId);
        expect(splitReconcile.peerUrl).toBe(authorityNode.url);
        expect(splitReconcile.prefix).toBe(scopeRoot);
        expect(splitReconcile.matches).toBe(true);
        expect(splitReconcile.attemptedChildren).toBe(1);
        expect(splitReconcile.reconciledChildren).toBe(1);

        const splitChildren = splitChildMap(splitReconcile.children);
        expect(splitChildren.get(primaryScope)?.beforeStatus).toBe("match");
        expect(splitChildren.get(primaryScope)?.afterStatus).toBe("match");
        expect(splitChildren.get(primaryScope)?.appliedSequences).toBe(0);
        expect(splitChildren.get(primaryScope)?.appliedEvents).toBe(0);
        expect(splitChildren.get(siblingScope)?.beforeStatus).toBe(
          "local-missing"
        );
        expect(splitChildren.get(siblingScope)?.afterStatus).toBe("match");
        expect(splitChildren.get(siblingScope)?.appliedSequences).toBeGreaterThan(
          0
        );
        expect(splitChildren.get(siblingScope)?.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("sibling KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(
            siblingProfileKey
          );
          return result.ok && result.data.data.scope === "sibling";
        });

        const compareAfter = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );
        expect(compareAfter.matches).toBe(true);
        expect(
          compareAfter.children.every((child) => child.status === "match")
        ).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
