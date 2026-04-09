import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconCompareFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication KV Recon Compare", () => {
  test(
    "reports mismatch before replay reconcile, match after reconcile, and keeps prefixes isolated",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-recon-compare");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scopeRoot = `replication/kv-recon-compare/${Date.now()}`;
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
        const beforeCompare = await reconCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          { target: targetSession, peer: peerSession }
        );

        expect(beforeCompare.spaceId).toBe(authority.spaceId);
        expect(beforeCompare.prefix).toBe(primaryScope);
        expect(beforeCompare.peerUrl).toBe(authorityNode.url);
        expect(beforeCompare.matches).toBe(false);
        expect(beforeCompare.localFingerprint).not.toBe(beforeCompare.peerFingerprint);
        expect(beforeCompare.peerItemCount).toBeGreaterThan(0);
        expect(beforeCompare.firstMismatchKey).toBeDefined();
        expect(beforeCompare.firstMismatchKey?.startsWith(primaryScope)).toBe(true);

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
          const result = await replica.kv.get<typeof primaryValue>(primaryKey);
          return result.ok && result.data.data.scope === "primary";
        });

        const postTargetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          primaryScope
        );
        const postPeerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          primaryScope
        );
        const afterCompare = await reconCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: primaryScope,
          },
          { target: postTargetSession, peer: postPeerSession }
        );

        expect(afterCompare.matches).toBe(true);
        expect(afterCompare.localItemCount).toBe(afterCompare.peerItemCount);
        expect(afterCompare.localFingerprint).toBe(afterCompare.peerFingerprint);
        expect(afterCompare.firstMismatchKey).toBeNull();

        const siblingTargetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          siblingScope
        );
        const siblingPeerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          siblingScope
        );
        const siblingCompare = await reconCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: siblingScope,
          },
          { target: siblingTargetSession, peer: siblingPeerSession }
        );

        expect(siblingCompare.matches).toBe(false);
        expect(siblingCompare.peerItemCount).toBeGreaterThan(0);
        expect(siblingCompare.firstMismatchKey).toBeDefined();
        expect(siblingCompare.firstMismatchKey?.startsWith(siblingScope)).toBe(true);
        expect(
          siblingCompare.firstMismatchKey?.startsWith(primaryScope)
        ).toBe(false);
      } finally {
        await cluster.stop();
      }
    }
  );
});
