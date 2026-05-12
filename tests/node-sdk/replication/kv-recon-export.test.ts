import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconExportFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

type ReconItem = {
  key: string;
  kind: string;
  invocationId?: string;
};

function normalizeReconInventory(items: ReconItem[]): ReconItem[] {
  return items.map(({ key, kind, invocationId }) => ({
    key,
    kind,
    invocationId,
  }));
}

describe("Replication KV Recon Export", () => {
  test(
    "exports the same scoped KV inventory after replay reconcile and ignores sibling prefixes",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-export");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon/${Date.now()}`;
        const primaryScope = `${scopeRoot}/primary`;
        const siblingScope = `${scopeRoot}/sibling`;
        const primaryKey = `${primaryScope}/profile.json`;
        const siblingKey = `${siblingScope}/profile.json`;

        const primaryValue = {
          owner: "alice",
          scope: "primary",
          createdAt: new Date().toISOString(),
        };
        const siblingValue = {
          owner: "alice",
          scope: "sibling",
          createdAt: new Date().toISOString(),
        };

        const primaryWrite = await authority.kv.put(primaryKey, primaryValue);
        expect(primaryWrite.ok).toBe(true);
        const siblingWrite = await authority.kv.put(siblingKey, siblingValue);
        expect(siblingWrite.ok).toBe(true);

        const peerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          primaryScope
        );
        const targetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          primaryScope
        );
        const firstPass = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          { target: targetSession, peer: peerSession }
        );

        expect(firstPass.appliedSequences).toBeGreaterThan(0);
        expect(firstPass.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("primary KV available on node-b", async () => {
          const result = await replica.kv.get<typeof primaryValue>(primaryKey);
          return result.ok && result.data.data.scope === "primary";
        });

        const authorityReconSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          primaryScope
        );
        const replicaReconSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          primaryScope
        );
        const authorityRecon = await reconExportFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          authorityReconSession
        );
        const replicaRecon = await reconExportFromPeer(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          replicaReconSession
        );

        expect(authorityRecon.spaceId).toBe(authority.spaceId);
        expect(replicaRecon.spaceId).toBe(authority.spaceId);
        expect(authorityRecon.prefix).toBe(primaryScope);
        expect(replicaRecon.prefix).toBe(primaryScope);

        const normalizedAuthorityRecon = normalizeReconInventory(
          authorityRecon.items as ReconItem[]
        );
        const normalizedReplicaRecon = normalizeReconInventory(
          replicaRecon.items as ReconItem[]
        );

        expect(normalizedReplicaRecon).toEqual(normalizedAuthorityRecon);
        expect(normalizedAuthorityRecon.length).toBeGreaterThan(0);
        expect(normalizedAuthorityRecon.every((item) => item.key.startsWith(primaryScope))).toBe(
          true
        );
        expect(
          normalizedAuthorityRecon.every((item) => !item.key.startsWith(siblingScope))
        ).toBe(true);

        const authorityReconRepeat = await reconExportFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          authorityReconSession
        );
        expect(
          normalizeReconInventory(authorityReconRepeat.items as ReconItem[])
        ).toEqual(normalizedAuthorityRecon);

        const siblingRecon = await reconExportFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: siblingScope,
          },
          await openKvReplicationSession(authority, authorityNode.url, siblingScope)
        );
        expect(siblingRecon.items.length).toBeGreaterThan(0);
        expect(
          siblingRecon.items.every((item) => item.key.startsWith(siblingScope))
        ).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
