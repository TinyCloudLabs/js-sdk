import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconCompareFromPeer,
  reconExportFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
  type KvReconCompareRequest,
  type KvReconCompareResponse,
  type KvReconExportRequest,
  type KvReconExportResponse,
  type KvReconItem,
  type ReplicationPullSessions,
} from "./helpers";
import type { RunningCluster } from "./cluster";

type ReconItemSummary = Pick<KvReconItem, "key" | "kind" | "invocationId">;

function normalizeReconItems(items: KvReconItem[]): ReconItemSummary[] {
  return items.map(({ key, kind, invocationId }) => ({
    key,
    kind,
    invocationId,
  }));
}

async function collectReconExportPages(
  cluster: RunningCluster,
  nodeName: string,
  request: KvReconExportRequest,
  session: Parameters<typeof reconExportFromPeer>[3]
): Promise<KvReconExportResponse[]> {
  const pages: KvReconExportResponse[] = [];
  let startAfter = request.startAfter;

  for (;;) {
    const page = await reconExportFromPeer(
      cluster,
      nodeName,
      {
        ...request,
        startAfter,
      },
      session
    );
    pages.push(page);

    if (!page.hasMore) {
      expect(page.nextStartAfter ?? null).toBeNull();
      break;
    }

    expect(page.nextStartAfter).toBeDefined();
    expect(page.nextStartAfter).not.toBe(startAfter);
    startAfter = page.nextStartAfter ?? undefined;
  }

  return pages;
}

async function collectReconComparePages(
  cluster: Awaited<ReturnType<typeof startCluster>>,
  nodeName: string,
  request: KvReconCompareRequest,
  sessions: ReplicationPullSessions
): Promise<KvReconCompareResponse[]> {
  const pages: KvReconCompareResponse[] = [];
  let startAfter = request.startAfter;

  for (;;) {
    const page = await reconCompareFromPeer(
      cluster,
      nodeName,
      {
        ...request,
        startAfter,
      },
      sessions
    );
    pages.push(page);

    if (!page.localHasMore && !page.peerHasMore) {
      expect(page.localNextStartAfter ?? null).toBeNull();
      expect(page.peerNextStartAfter ?? null).toBeNull();
      break;
    }

    expect(page.localHasMore).toBe(page.peerHasMore);
    expect(page.localNextStartAfter).toBe(page.peerNextStartAfter);
    expect(page.localNextStartAfter).not.toBe(startAfter);
    startAfter = page.localNextStartAfter ?? undefined;
  }

  return pages;
}

describe("Replication KV Recon Windows", () => {
  test(
    "traverses bounded windows after reconcile and keeps sibling prefixes isolated",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-window");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-window/${Date.now()}`;
        const primaryScope = `${scopeRoot}/primary`;
        const siblingScope = `${scopeRoot}/sibling`;

        const primaryEntries = [
          { key: `${primaryScope}/alpha.json`, value: { scope: "primary", name: "alpha" } },
          { key: `${primaryScope}/bravo.json`, value: { scope: "primary", name: "bravo" } },
          { key: `${primaryScope}/charlie.json`, value: { scope: "primary", name: "charlie" } },
          { key: `${primaryScope}/delta.json`, value: { scope: "primary", name: "delta" } },
        ];
        const siblingEntries = [
          { key: `${siblingScope}/echo.json`, value: { scope: "sibling", name: "echo" } },
          { key: `${siblingScope}/foxtrot.json`, value: { scope: "sibling", name: "foxtrot" } },
          { key: `${siblingScope}/golf.json`, value: { scope: "sibling", name: "golf" } },
        ];

        for (const entry of [...primaryEntries, ...siblingEntries]) {
          const write = await authority.kv.put(entry.key, {
            ...entry.value,
            createdAt: new Date().toISOString(),
          });
          expect(write.ok).toBe(true);
        }

        const targetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          primaryScope
        );
        const peerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          primaryScope
        );
        const reconcileResult = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          { target: targetSession, peer: peerSession }
        );

        expect(reconcileResult.appliedSequences).toBeGreaterThan(0);
        expect(reconcileResult.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("primary KV available on node-b", async () => {
          const result = await replica.kv.get(primaryEntries[0].key);
          return result.ok && result.data.data.scope === "primary";
        });

        const primaryComparePages = await collectReconComparePages(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: primaryScope,
            limit: 2,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, primaryScope),
            peer: await openKvReplicationSession(authority, authorityNode.url, primaryScope),
          }
        );

        expect(primaryComparePages.length).toBeGreaterThan(1);
        expect(primaryComparePages.every((page) => page.matches)).toBe(true);
        expect(
          primaryComparePages.every((page) => page.localItemCount === page.peerItemCount)
        ).toBe(true);
        expect(primaryComparePages[0].localHasMore).toBe(true);
        expect(primaryComparePages[0].peerHasMore).toBe(true);
        expect(primaryComparePages[0].localNextStartAfter).toBe(
          primaryComparePages[0].peerNextStartAfter
        );
        expect(
          primaryComparePages[primaryComparePages.length - 1].localHasMore
        ).toBe(false);
        expect(
          primaryComparePages[primaryComparePages.length - 1].peerHasMore
        ).toBe(false);

        const authorityExportPages = await collectReconExportPages(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: primaryScope,
            limit: 2,
          },
          await openKvReplicationSession(authority, authorityNode.url, primaryScope)
        );
        const replicaExportPages = await collectReconExportPages(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: primaryScope,
            limit: 2,
          },
          await openKvReplicationSession(replica, replicaNode.url, primaryScope)
        );

        expect(authorityExportPages.length).toBeGreaterThan(1);
        expect(replicaExportPages.length).toBeGreaterThan(1);
        expect(authorityExportPages[0].hasMore).toBe(true);
        expect(replicaExportPages[0].hasMore).toBe(true);
        expect(
          authorityExportPages[authorityExportPages.length - 1].hasMore
        ).toBe(false);
        expect(replicaExportPages[replicaExportPages.length - 1].hasMore).toBe(false);

        const authorityItems = authorityExportPages.flatMap((page) => page.items);
        const replicaItems = replicaExportPages.flatMap((page) => page.items);

        expect(normalizeReconItems(replicaItems)).toEqual(
          normalizeReconItems(authorityItems)
        );
        expect(authorityItems.length).toBeGreaterThan(0);
        expect(
          authorityItems.every((item) => item.key.startsWith(primaryScope))
        ).toBe(true);
        expect(authorityItems.every((item) => !item.key.startsWith(siblingScope))).toBe(
          true
        );
        expect(
          replicaItems.every((item) => item.key.startsWith(primaryScope))
        ).toBe(true);
        expect(replicaItems.every((item) => !item.key.startsWith(siblingScope))).toBe(
          true
        );

        const siblingCompare = await reconCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: siblingScope,
            limit: 1,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, siblingScope),
            peer: await openKvReplicationSession(authority, authorityNode.url, siblingScope),
          }
        );

        expect(siblingCompare.matches).toBe(false);
        expect(siblingCompare.peerItemCount).toBeGreaterThan(0);
        expect(siblingCompare.peerHasMore).toBe(true);
        expect(siblingCompare.localHasMore).toBe(false);
        expect(siblingCompare.firstMismatchKey).toBeDefined();
        expect(siblingCompare.firstMismatchKey?.startsWith(siblingScope)).toBe(true);
        expect(siblingCompare.firstMismatchKey?.startsWith(primaryScope)).toBe(false);
      } finally {
        await cluster.stop();
      }
    }
  );
});
