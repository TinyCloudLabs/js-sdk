import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openAuthReplicationSession,
  openKvReplicationSession,
  peerMissingApplyFromPeer,
  reconcileAuthFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication KV Quarantine Visibility", () => {
  test(
    "defaults reads to canonical visibility and allows provisional overrides for quarantined keys",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-quarantine-visibility");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const canonicalReplica = createClusterClient(cluster, "node-b", prefix);
        const provisionalReplica = createClusterClient(cluster, "node-b", prefix, undefined, {
          kvConfig: { readMode: "provisional" },
        });
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await canonicalReplica.signIn();
        await provisionalReplica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(canonicalReplica.spaceId).toBe(authority.spaceId);
        expect(provisionalReplica.spaceId).toBe(authority.spaceId);

        const scope = `replication/kv-quarantine-visibility/${Date.now()}`;
        const key = `${scope}/local-only.json`;
        const value = {
          stage: "local-only",
          createdAt: new Date().toISOString(),
        };

        expect(await canonicalReplica.kv.put(key, value)).toMatchObject({ ok: true });

        await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: await openAuthReplicationSession(canonicalReplica, replicaNode.url),
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
            target: await openKvReplicationSession(canonicalReplica, replicaNode.url, scope),
            peer: await openKvReplicationSession(authority, authorityNode.url, scope),
          }
        );

        expect(firstApply.quarantined).toBeGreaterThanOrEqual(1);

        const canonicalGet = await canonicalReplica.kv.get(key);
        expect(canonicalGet.ok).toBe(false);
        if (canonicalGet.ok) {
          throw new Error("Expected canonical read to hide quarantined key");
        }
        expect(canonicalGet.error.code).toBe("KV_NOT_FOUND");

        const canonicalHead = await canonicalReplica.kv.head(key);
        expect(canonicalHead.ok).toBe(false);
        if (canonicalHead.ok) {
          throw new Error("Expected canonical head to hide quarantined key");
        }
        expect(canonicalHead.error.code).toBe("KV_NOT_FOUND");

        const canonicalList = await canonicalReplica.kv.list({ prefix: scope });
        expect(canonicalList.ok).toBe(true);
        if (!canonicalList.ok) {
          throw new Error(canonicalList.error.message);
        }
        expect(canonicalList.data.keys).not.toContain(key);

        const provisionalGet = await canonicalReplica.kv.get<typeof value>(key, {
          readMode: "provisional",
        });
        expect(provisionalGet.ok).toBe(true);
        if (!provisionalGet.ok) {
          throw new Error(provisionalGet.error.message);
        }
        expect(provisionalGet.data.data).toEqual(value);

        const provisionalHead = await canonicalReplica.kv.head(key, {
          readMode: "provisional",
        });
        expect(provisionalHead.ok).toBe(true);

        const provisionalList = await canonicalReplica.kv.list({
          prefix: scope,
          readMode: "provisional",
        });
        expect(provisionalList.ok).toBe(true);
        if (!provisionalList.ok) {
          throw new Error(provisionalList.error.message);
        }
        expect(provisionalList.data.keys).toContain(key);

        const configuredProvisionalGet = await provisionalReplica.kv.get<typeof value>(key);
        expect(configuredProvisionalGet.ok).toBe(true);
        if (!configuredProvisionalGet.ok) {
          throw new Error(configuredProvisionalGet.error.message);
        }
        expect(configuredProvisionalGet.data.data).toEqual(value);

        const authorityPull = await authority.reconcileKvFromPeer(
          {
            target: await openKvReplicationSession(authority, authorityNode.url, scope),
            peer: await openKvReplicationSession(canonicalReplica, replicaNode.url, scope),
          },
          {
            peerUrl: replicaNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          }
        );
        expect(authorityPull.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("authority sees quarantined key before keep resolution", async () => {
          const result = await authority.kv.get<typeof value>(key);
          return result.ok && result.data.data.stage === value.stage;
        });

        const secondApply = await peerMissingApplyFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          {
            target: await openKvReplicationSession(canonicalReplica, replicaNode.url, scope),
            peer: await openKvReplicationSession(authority, authorityNode.url, scope),
          }
        );
        expect(secondApply.kept).toBeGreaterThanOrEqual(1);
        expect(secondApply.clearedQuarantine).toBeGreaterThanOrEqual(1);

        await waitForCondition("canonical reads show key again after quarantine clears", async () => {
          const result = await canonicalReplica.kv.get<typeof value>(key);
          return result.ok && result.data.data.stage === value.stage;
        });

        const finalCanonicalList = await canonicalReplica.kv.list({ prefix: scope });
        expect(finalCanonicalList.ok).toBe(true);
        if (!finalCanonicalList.ok) {
          throw new Error(finalCanonicalList.error.message);
        }
        expect(finalCanonicalList.data.keys).toContain(key);
      } finally {
        await cluster.stop();
      }
    }
  );
});
