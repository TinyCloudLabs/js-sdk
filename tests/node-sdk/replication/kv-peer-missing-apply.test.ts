import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  peerMissingApplyFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication Peer Missing Apply", () => {
  test(
    "applies delete-backed actions and persists absent keys as quarantine records",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("peer-missing-apply");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/peer-missing-apply/${Date.now()}`;
        const deletedKey = `${scope}/deleted.json`;
        const localOnlyKey = `${scope}/local-only.json`;

        expect(
          await authority.kv.put(deletedKey, { state: "deleted-on-peer" })
        ).toMatchObject({ ok: true });

        const firstPass = await reconcileFromPeer(
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

        expect(firstPass.appliedEvents).toBeGreaterThan(0);
        await waitForCondition("replica has initial delete candidate key", async () => {
          const result = await replica.kv.get(deletedKey);
          return result.ok;
        });

        expect(await authority.kv.delete(deletedKey)).toMatchObject({ ok: true });
        expect(await replica.kv.put(localOnlyKey, { state: "local-only" })).toMatchObject({
          ok: true,
        });

        const apply = await peerMissingApplyFromPeer(
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

        expect(apply.spaceId).toBe(authority.spaceId);
        expect(apply.prefix).toBe(scope);
        expect(apply.peerUrl).toBe(authorityNode.url);
        expect(apply.peerHostRole).toBe(true);
        expect(apply.prunedDeletes).toBeGreaterThanOrEqual(1);
        expect(apply.quarantined).toBeGreaterThanOrEqual(1);
        expect(apply.alreadyQuarantined).toBe(0);

        await waitForCondition("replica no longer serves delete-backed key", async () => {
          const result = await replica.kv.get(deletedKey);
          return !result.ok;
        });

        const deletedResult = await replica.kv.get(deletedKey);
        expect(deletedResult.ok).toBe(false);

        const localOnlyResult = await replica.kv.get<{ state: string }>(localOnlyKey);
        expect(localOnlyResult.ok).toBe(true);
        if (!localOnlyResult.ok) {
          throw new Error(localOnlyResult.error.message);
        }
        expect(localOnlyResult.data.data.state).toBe("local-only");

        const repeatApply = await peerMissingApplyFromPeer(
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

        expect(repeatApply.prunedDeletes).toBe(0);
        expect(repeatApply.quarantined).toBe(0);
        expect(repeatApply.alreadyQuarantined).toBeGreaterThanOrEqual(1);
      } finally {
        await cluster.stop();
      }
    }
  );
});
