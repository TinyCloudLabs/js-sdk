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

function compareChildMap(
  children: {
    prefix: string;
    status: "match" | "local-missing" | "peer-missing" | "mismatch";
    localItemCount: number;
    peerItemCount: number;
  }[]
) {
  return new Map(children.map((child) => [child.prefix, child]));
}

describe("Replication KV Split-Driven Grandchild Replay", () => {
  test(
    "pages deeper mismatched grandchild prefixes before replaying a coarse child scope",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-split-grandchild");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-split-grandchild/${Date.now()}`;
        const coarseScope = `${scopeRoot}/library`;
        const chapterAScope = `${coarseScope}/chapter-a`;
        const chapterBScope = `${coarseScope}/chapter-b`;
        const chapterAProfileKey = `${chapterAScope}/profile.json`;
        const chapterAAssetKey = `${chapterAScope}/assets/cover.json`;
        const chapterBProfileKey = `${chapterBScope}/profile.json`;

        expect(
          await authority.kv.put(chapterAProfileKey, {
            owner: "alice",
            scope: "chapter-a",
            kind: "profile",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });
        expect(
          await authority.kv.put(chapterAAssetKey, {
            owner: "alice",
            scope: "chapter-a",
            kind: "asset",
            createdAt: new Date().toISOString(),
          })
        ).toMatchObject({ ok: true });
        expect(
          await authority.kv.put(chapterBProfileKey, {
            owner: "alice",
            scope: "chapter-b",
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
        const coarseTargetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          coarseScope
        );
        const coarsePeerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          coarseScope
        );

        const rootBefore = await reconSplitCompareFromPeer(
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
        const rootBeforeChildren = compareChildMap(rootBefore.children);
        expect(rootBefore.matches).toBe(false);
        expect(rootBeforeChildren.get(coarseScope)?.status).toBe(
          "local-missing"
        );
        expect(rootBeforeChildren.get(coarseScope)?.localItemCount).toBe(0);
        expect(rootBeforeChildren.get(coarseScope)?.peerItemCount).toBe(3);

        const coarseBefore = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: coarseScope,
          },
          {
            target: coarseTargetSession,
            peer: coarsePeerSession,
          }
        );
        const coarseBeforeChildren = compareChildMap(coarseBefore.children);
        expect(coarseBefore.matches).toBe(false);
        expect(coarseBeforeChildren.get(chapterAScope)?.status).toBe(
          "local-missing"
        );
        expect(coarseBeforeChildren.get(chapterAScope)?.peerItemCount).toBe(2);
        expect(coarseBeforeChildren.get(chapterBScope)?.status).toBe(
          "local-missing"
        );
        expect(coarseBeforeChildren.get(chapterBScope)?.peerItemCount).toBe(1);

        const firstSplitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 1,
            maxDepth: 2,
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
        expect(firstSplitReconcile.reconciledChildren).toBe(0);

        const firstSplitChildren = splitChildMap(firstSplitReconcile.children);
        expect(firstSplitChildren.get(coarseScope)?.beforeStatus).toBe(
          "local-missing"
        );
        expect(firstSplitChildren.get(coarseScope)?.afterStatus).toBe("mismatch");
        expect(
          firstSplitChildren.get(coarseScope)?.appliedSequences
        ).toBeGreaterThan(0);
        expect(firstSplitChildren.get(coarseScope)?.appliedEvents).toBeGreaterThan(
          0
        );

        await waitForCondition("chapter-a KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(
            chapterAProfileKey
          );
          return result.ok && result.data.data.scope === "chapter-a";
        });

        const chapterBBefore = await replica.kv.get<{ scope: string }>(
          chapterBProfileKey
        );
        expect(chapterBBefore.ok).toBe(false);

        const rootAfterFirst = await reconSplitCompareFromPeer(
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
        const rootAfterFirstChildren = compareChildMap(rootAfterFirst.children);
        expect(rootAfterFirst.matches).toBe(false);
        expect(rootAfterFirstChildren.get(coarseScope)?.status).toBe("mismatch");

        const coarseAfterFirst = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: coarseScope,
          },
          {
            target: coarseTargetSession,
            peer: coarsePeerSession,
          }
        );
        const coarseAfterFirstChildren = compareChildMap(coarseAfterFirst.children);
        expect(coarseAfterFirst.matches).toBe(false);
        expect(coarseAfterFirstChildren.get(chapterAScope)?.status).toBe(
          "match"
        );
        expect(coarseAfterFirstChildren.get(chapterBScope)?.status).toBe(
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
            maxDepth: 2,
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

        const secondSplitChildren = splitChildMap(secondSplitReconcile.children);
        expect(secondSplitChildren.get(coarseScope)?.beforeStatus).toBe(
          "mismatch"
        );
        expect(secondSplitChildren.get(coarseScope)?.afterStatus).toBe("match");
        expect(
          secondSplitChildren.get(coarseScope)?.appliedSequences
        ).toBeGreaterThan(0);
        expect(secondSplitChildren.get(coarseScope)?.appliedEvents).toBeGreaterThan(
          0
        );

        await waitForCondition("chapter-b KV available on node-b", async () => {
          const result = await replica.kv.get<{ scope: string }>(
            chapterBProfileKey
          );
          return result.ok && result.data.data.scope === "chapter-b";
        });

        const coarseAfterSecond = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: coarseScope,
          },
          {
            target: coarseTargetSession,
            peer: coarsePeerSession,
          }
        );
        const rootAfterSecond = await reconSplitCompareFromPeer(
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
        expect(coarseAfterSecond.matches).toBe(true);
        expect(
          coarseAfterSecond.children.every((child) => child.status === "match")
        ).toBe(true);
        expect(rootAfterSecond.matches).toBe(true);
        expect(
          rootAfterSecond.children.every((child) => child.status === "match")
        ).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
