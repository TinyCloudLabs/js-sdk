import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconSplitCompareFromPeer,
  reconSplitFromPeer,
  uniqueReplicationPrefix,
} from "./helpers";

function childPrefixMap(
  children: {
    prefix: string;
  }[]
) {
  return new Map(children.map((child) => [child.prefix, child]));
}

describe("Replication KV Split Child Pagination", () => {
  test(
    "pages wide child lists deterministically with childStartAfter and childLimit",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-split-pagination");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-split-pagination/${Date.now()}`;
        const childScopes = [
          `${scopeRoot}/alpha`,
          `${scopeRoot}/bravo`,
          `${scopeRoot}/charlie`,
          `${scopeRoot}/delta`,
        ];

        for (const [index, childScope] of childScopes.entries()) {
          const write = await authority.kv.put(`${childScope}/profile.json`, {
            owner: "alice",
            scope: childScope,
            ordinal: index,
            createdAt: new Date().toISOString(),
          });
          expect(write.ok).toBe(true);
        }

        const targetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scopeRoot
        );
        const peerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scopeRoot
        );

        const firstSplitPage = await reconSplitFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 2,
          },
          peerSession
        );
        expect(firstSplitPage.hasMore).toBe(true);
        expect(firstSplitPage.childStartAfter ?? null).toBeNull();
        expect(firstSplitPage.childLimit).toBe(2);
        expect(firstSplitPage.nextChildStartAfter).toBeDefined();
        expect(firstSplitPage.children.length).toBe(2);
        expect(firstSplitPage.children.map((child) => child.prefix)).toEqual([
          childScopes[0],
          childScopes[1],
        ]);

        const secondSplitPage = await reconSplitFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childStartAfter: firstSplitPage.nextChildStartAfter ?? undefined,
            childLimit: 2,
          },
          peerSession
        );
        expect(secondSplitPage.hasMore).toBe(false);
        expect(secondSplitPage.childStartAfter).toBe(
          firstSplitPage.nextChildStartAfter ?? undefined
        );
        expect(secondSplitPage.childLimit).toBe(2);
        expect(secondSplitPage.nextChildStartAfter ?? null).toBeNull();
        expect(secondSplitPage.children.length).toBe(2);
        expect(secondSplitPage.children.map((child) => child.prefix)).toEqual([
          childScopes[2],
          childScopes[3],
        ]);

        const pagePrefixes = childPrefixMap([
          ...firstSplitPage.children,
          ...secondSplitPage.children,
        ]);
        expect(pagePrefixes.size).toBe(4);
        expect([...pagePrefixes.keys()]).toEqual(
          childScopes.sort()
        );

        const firstComparePage = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childLimit: 2,
          },
          {
            target: targetSession,
            peer: peerSession,
          }
        );
        expect(firstComparePage.matches).toBe(false);
        expect(firstComparePage.hasMore).toBe(true);
        expect(firstComparePage.childStartAfter ?? null).toBeNull();
        expect(firstComparePage.childLimit).toBe(2);
        expect(firstComparePage.nextChildStartAfter).toBeDefined();
        expect(firstComparePage.children.length).toBe(2);
        expect(firstComparePage.children.map((child) => child.prefix)).toEqual([
          childScopes[0],
          childScopes[1],
        ]);
        expect(
          firstComparePage.children.every(
            (child) => child.status === "local-missing"
          )
        ).toBe(true);

        const secondComparePage = await reconSplitCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scopeRoot,
            childStartAfter: firstComparePage.nextChildStartAfter ?? undefined,
            childLimit: 2,
          },
          {
            target: targetSession,
            peer: peerSession,
          }
        );
        expect(secondComparePage.matches).toBe(false);
        expect(secondComparePage.hasMore).toBe(false);
        expect(secondComparePage.childStartAfter).toBe(
          firstComparePage.nextChildStartAfter ?? undefined
        );
        expect(secondComparePage.childLimit).toBe(2);
        expect(secondComparePage.nextChildStartAfter ?? null).toBeNull();
        expect(secondComparePage.children.length).toBe(2);
        expect(secondComparePage.children.map((child) => child.prefix)).toEqual([
          childScopes[2],
          childScopes[3],
        ]);
        expect(
          secondComparePage.children.every(
            (child) => child.status === "local-missing"
          )
        ).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
