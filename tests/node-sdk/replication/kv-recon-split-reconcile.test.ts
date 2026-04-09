import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconSplitCompareFromPeer,
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
        expect(compareBeforeChildren.get(primaryScope)?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(primaryScope)?.localItemCount).toBe(0);
        expect(compareBeforeChildren.get(primaryScope)?.peerItemCount).toBe(2);
        expect(compareBeforeChildren.get(siblingScope)?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(siblingScope)?.localItemCount).toBe(0);
        expect(compareBeforeChildren.get(siblingScope)?.peerItemCount).toBe(1);

        const firstSplitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 1,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );

        expect(firstSplitReconcile.spaceId).toBe(authority.spaceId);
        expect(firstSplitReconcile.peerUrl).toBe(authorityNode.url);
        expect(firstSplitReconcile.prefix).toBe(scopeRoot);
        expect(firstSplitReconcile.matches).toBe(false);
        expect(firstSplitReconcile.attemptedChildren).toBe(1);
        expect(firstSplitReconcile.reconciledChildren).toBe(1);

        const firstSplitChildren = splitChildMap(firstSplitReconcile.children);
        expect(firstSplitChildren.get(primaryScope)?.beforeStatus).toBe(
          "local-missing"
        );
        expect(firstSplitChildren.get(primaryScope)?.afterStatus).toBe("match");
        expect(
          firstSplitChildren.get(primaryScope)?.appliedSequences
        ).toBeGreaterThan(0);
        expect(firstSplitChildren.get(primaryScope)?.appliedEvents).toBeGreaterThan(
          0
        );
        expect(firstSplitChildren.get(siblingScope)?.beforeStatus).toBe(
          "local-missing"
        );
        expect(firstSplitChildren.get(siblingScope)?.afterStatus).toBe(
          "local-missing"
        );
        expect(firstSplitChildren.get(siblingScope)?.appliedSequences).toBe(0);
        expect(firstSplitChildren.get(siblingScope)?.appliedEvents).toBe(0);

        await waitForCondition("primary KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(
            primaryProfileKey
          );
          return result.ok && result.data.data.scope === "primary";
        });

        const compareAfterFirst = await reconSplitCompareFromPeer(
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
        const compareAfterFirstChildren = splitChildMap(
          compareAfterFirst.children
        );
        expect(compareAfterFirst.matches).toBe(false);
        expect(compareAfterFirstChildren.get(primaryScope)?.status).toBe(
          "match"
        );
        expect(compareAfterFirstChildren.get(siblingScope)?.status).toBe(
          "local-missing"
        );

        const secondSplitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 1,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );

        expect(secondSplitReconcile.spaceId).toBe(authority.spaceId);
        expect(secondSplitReconcile.peerUrl).toBe(authorityNode.url);
        expect(secondSplitReconcile.prefix).toBe(scopeRoot);
        expect(secondSplitReconcile.matches).toBe(true);
        expect(secondSplitReconcile.attemptedChildren).toBe(1);
        expect(secondSplitReconcile.reconciledChildren).toBe(1);

        const splitChildren = splitChildMap(secondSplitReconcile.children);
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
        expect(splitChildren.get(siblingScope)?.appliedEvents).toBeGreaterThan(
          0
        );

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
