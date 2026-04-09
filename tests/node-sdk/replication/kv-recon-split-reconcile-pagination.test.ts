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

function splitChildResultMap(
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

describe("Replication KV Split-Driven Reconcile Pagination", () => {
  test(
    "pages wide child reconcile deterministically without changing peer-missing semantics",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-split-reconcile-pagination");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-split-reconcile-pagination/${Date.now()}`;
        const childScopes = [
          `${scopeRoot}/alpha`,
          `${scopeRoot}/bravo`,
          `${scopeRoot}/charlie`,
          `${scopeRoot}/delta`,
        ];
        const peerMissingScope = `${scopeRoot}/zulu`;

        for (const [index, childScope] of childScopes.entries()) {
          const write = await authority.kv.put(`${childScope}/profile.json`, {
            owner: "alice",
            scope: childScope,
            ordinal: index,
            createdAt: new Date().toISOString(),
          });
          expect(write.ok).toBe(true);
        }

        const peerOnlyWrite = await replica.kv.put(`${peerMissingScope}/profile.json`, {
          owner: "alice",
          scope: peerMissingScope,
          kind: "peer-only",
          createdAt: new Date().toISOString(),
        });
        expect(peerOnlyWrite.ok).toBe(true);

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
        const compareBeforeChildren = childStatusMap(compareBefore.children);
        expect(compareBefore.matches).toBe(false);
        expect(compareBeforeChildren.get(childScopes[0])?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(childScopes[1])?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(childScopes[2])?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(childScopes[3])?.status).toBe(
          "local-missing"
        );
        expect(compareBeforeChildren.get(peerMissingScope)?.status).toBe(
          "peer-missing"
        );

        const firstSplitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 2,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );
        expect(firstSplitReconcile.matches).toBe(false);
        expect(firstSplitReconcile.childStartAfter ?? null).toBeNull();
        expect(firstSplitReconcile.childLimit).toBe(2);
        expect(firstSplitReconcile.hasMore).toBe(true);
        expect(firstSplitReconcile.nextChildStartAfter).toBeDefined();
        expect(firstSplitReconcile.children.length).toBe(2);

        const firstSplitChildren = splitChildResultMap(firstSplitReconcile.children);
        expect(firstSplitChildren.get(childScopes[0])?.beforeStatus).toBe(
          "local-missing"
        );
        expect(firstSplitChildren.get(childScopes[0])?.afterStatus).toBe("match");
        expect(firstSplitChildren.get(childScopes[1])?.beforeStatus).toBe(
          "local-missing"
        );
        expect(firstSplitChildren.get(childScopes[1])?.afterStatus).toBe("match");

        await waitForCondition("first page children available on node-b", async () => {
          const first = await replica.kv.get<{ scope: string }>(
            `${childScopes[0]}/profile.json`
          );
          const second = await replica.kv.get<{ scope: string }>(
            `${childScopes[1]}/profile.json`
          );
          return (
            first.ok &&
            second.ok &&
            first.data.data.scope === childScopes[0] &&
            second.data.data.scope === childScopes[1]
          );
        });
        const secondPageCursor = firstSplitReconcile.nextChildStartAfter;
        expect(secondPageCursor).toBeDefined();

        const secondSplitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childStartAfter: secondPageCursor === null ? undefined : secondPageCursor,
            childLimit: 2,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );
        expect(secondSplitReconcile.matches).toBe(false);
        expect(secondSplitReconcile.childStartAfter).toBe(secondPageCursor);
        expect(secondSplitReconcile.childLimit).toBe(2);
        expect(secondSplitReconcile.hasMore).toBe(true);
        expect(secondSplitReconcile.nextChildStartAfter).toBeDefined();
        expect(secondSplitReconcile.children.length).toBe(2);

        const secondSplitChildren = splitChildResultMap(secondSplitReconcile.children);
        expect(secondSplitChildren.get(childScopes[2])?.beforeStatus).toBe(
          "local-missing"
        );
        expect(secondSplitChildren.get(childScopes[2])?.afterStatus).toBe("match");
        expect(secondSplitChildren.get(childScopes[3])?.beforeStatus).toBe(
          "local-missing"
        );
        expect(secondSplitChildren.get(childScopes[3])?.afterStatus).toBe("match");

        await waitForCondition("second page children available on node-b", async () => {
          const third = await replica.kv.get<{ scope: string }>(
            `${childScopes[2]}/profile.json`
          );
          const fourth = await replica.kv.get<{ scope: string }>(
            `${childScopes[3]}/profile.json`
          );
          return (
            third.ok &&
            fourth.ok &&
            third.data.data.scope === childScopes[2] &&
            fourth.data.data.scope === childScopes[3]
          );
        });
        const thirdPageCursor = secondSplitReconcile.nextChildStartAfter;
        expect(thirdPageCursor).toBeDefined();

        const thirdSplitReconcile = await reconcileSplitFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childStartAfter: thirdPageCursor === null ? undefined : thirdPageCursor,
            childLimit: 2,
          },
          {
            target: rootTargetSession,
            peer: rootPeerSession,
          }
        );
        expect(thirdSplitReconcile.matches).toBe(false);
        expect(thirdSplitReconcile.childStartAfter).toBe(thirdPageCursor);
        expect(thirdSplitReconcile.childLimit).toBe(2);
        expect(thirdSplitReconcile.hasMore).toBe(false);
        expect(thirdSplitReconcile.nextChildStartAfter ?? null).toBeNull();
        expect(thirdSplitReconcile.children.length).toBe(1);
        expect(thirdSplitReconcile.attemptedChildren).toBe(0);
        expect(thirdSplitReconcile.reconciledChildren).toBe(0);

        const thirdSplitChildren = splitChildResultMap(thirdSplitReconcile.children);
        expect(thirdSplitChildren.get(peerMissingScope)?.beforeStatus).toBe(
          "peer-missing"
        );
        expect(thirdSplitChildren.get(peerMissingScope)?.afterStatus).toBe(
          "peer-missing"
        );
        expect(thirdSplitChildren.get(peerMissingScope)?.appliedSequences).toBe(0);
        expect(thirdSplitChildren.get(peerMissingScope)?.appliedEvents).toBe(0);

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
        const compareAfterChildren = childStatusMap(compareAfter.children);
        expect(compareAfter.matches).toBe(false);
        expect(compareAfterChildren.get(childScopes[0])?.status).toBe("match");
        expect(compareAfterChildren.get(childScopes[1])?.status).toBe("match");
        expect(compareAfterChildren.get(childScopes[2])?.status).toBe("match");
        expect(compareAfterChildren.get(childScopes[3])?.status).toBe("match");
        expect(compareAfterChildren.get(peerMissingScope)?.status).toBe(
          "peer-missing"
        );
      } finally {
        await cluster.stop();
      }
    }
  );
});
