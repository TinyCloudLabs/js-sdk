import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openAuthReplicationSession,
  openKvReplicationSession,
  peerMissingApplyFromPeer,
  peerMissingQuarantineFromLocal,
  reconcileAuthFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

function quarantineKeys(items: { key: string }[]) {
  return new Set(items.map((item) => item.key));
}

function expectKvNotFound(result: { ok: boolean; error?: { code: string; message: string } }) {
  expect(result.ok).toBe(false);
  if (result.ok || !result.error) {
    throw new Error("Expected KV lookup to fail");
  }
  expect(result.error.code).toBe("KV_NOT_FOUND");
}

describe("Replication Peer Missing Quarantine", () => {
  test(
    "hides quarantined keys in canonical reads and reveals them with provisional reads",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("peer-missing-quarantine");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/peer-missing-quarantine/${Date.now()}`;
        const keepKey = `${scope}/keep.json`;
        const pruneKey = `${scope}/prune.json`;

        expect(await replica.kv.put(keepKey, { state: "local-only-keep" })).toMatchObject({
          ok: true,
        });
        expect(await replica.kv.put(pruneKey, { state: "local-only-prune" })).toMatchObject({
          ok: true,
        });

        await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: await openAuthReplicationSession(replica, replicaNode.url),
            peer: await openAuthReplicationSession(authority, authorityNode.url),
          }
        );

        const firstApply = await peerMissingApplyFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, scope),
            peer: await openKvReplicationSession(authority, authorityNode.url, scope),
          }
        );

        expect(firstApply.quarantined).toBeGreaterThanOrEqual(2);
        expect(firstApply.clearedQuarantine).toBe(0);

        const quarantineBefore = await peerMissingQuarantineFromLocal(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          await openKvReplicationSession(replica, replicaNode.url, scope)
        );

        const beforeKeys = quarantineKeys(quarantineBefore.items);
        expect(beforeKeys.has(keepKey)).toBe(true);
        expect(beforeKeys.has(pruneKey)).toBe(true);

        const canonicalKeep = await replica.kv.get(keepKey);
        expectKvNotFound(canonicalKeep);

        const provisionalKeep = await replica.kv.get<{ state: string }>(keepKey, {
          readMode: "provisional",
        });
        expect(provisionalKeep.ok).toBe(true);
        if (!provisionalKeep.ok) {
          throw new Error(provisionalKeep.error.message);
        }
        expect(provisionalKeep.data.data.state).toBe("local-only-keep");

        const canonicalList = await replica.kv.list({ prefix: scope });
        expect(canonicalList.ok).toBe(true);
        if (!canonicalList.ok) {
          throw new Error(canonicalList.error.message);
        }
        expect(canonicalList.data.keys).not.toContain(keepKey);
        expect(canonicalList.data.keys).not.toContain(pruneKey);

        const provisionalList = await replica.kv.list({
          prefix: scope,
          readMode: "provisional",
        });
        expect(provisionalList.ok).toBe(true);
        if (!provisionalList.ok) {
          throw new Error(provisionalList.error.message);
        }
        expect(provisionalList.data.keys).toEqual(
          expect.arrayContaining([keepKey, pruneKey])
        );

        const canonicalHead = await replica.kv.head(pruneKey);
        expectKvNotFound(canonicalHead);

        const provisionalHead = await replica.kv.head(pruneKey, {
          readMode: "provisional",
        });
        expect(provisionalHead.ok).toBe(true);
        if (!provisionalHead.ok) {
          throw new Error(provisionalHead.error.message);
        }

        const authorityPull = await reconcileFromPeer(
          cluster,
          "node-a",
          {
            peerUrl: replicaNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(authority, authorityNode.url, scope),
            peer: await openKvReplicationSession(replica, replicaNode.url, scope),
          }
        );

        expect(authorityPull.appliedEvents).toBeGreaterThan(0);
        await waitForCondition("authority now sees replica-authored keys", async () => {
          const keep = await authority.kv.get(keepKey);
          const prune = await authority.kv.get(pruneKey);
          return keep.ok && prune.ok;
        });

        expect(await authority.kv.delete(pruneKey)).toMatchObject({ ok: true });

        const secondApply = await peerMissingApplyFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(replica, replicaNode.url, scope),
            peer: await openKvReplicationSession(authority, authorityNode.url, scope),
          }
        );

        expect(secondApply.kept).toBeGreaterThanOrEqual(1);
        expect(secondApply.prunedDeletes).toBeGreaterThanOrEqual(1);
        expect(secondApply.clearedQuarantine).toBeGreaterThanOrEqual(2);

        const appliedItems = new Map(
          secondApply.items.map((item) => [item.key, item])
        );
        expect(appliedItems.get(keepKey)?.action).toBe("keep");
        expect(appliedItems.get(keepKey)?.clearedQuarantine).toBe(true);
        expect(appliedItems.get(pruneKey)?.action).toBe("prune-delete");
        expect(appliedItems.get(pruneKey)?.clearedQuarantine).toBe(true);

        await waitForCondition("replica no longer serves prune key", async () => {
          const result = await replica.kv.get(pruneKey);
          return !result.ok;
        });

        const keepResult = await replica.kv.get<{ state: string }>(keepKey);
        expect(keepResult.ok).toBe(true);
        if (!keepResult.ok) {
          throw new Error(keepResult.error.message);
        }
        expect(keepResult.data.data.state).toBe("local-only-keep");

        const quarantineAfter = await peerMissingQuarantineFromLocal(
          cluster,
          "node-b",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          await openKvReplicationSession(replica, replicaNode.url, scope)
        );

        expect(quarantineAfter.items).toHaveLength(0);
      } finally {
        await cluster.stop();
      }
    }
  );
});
