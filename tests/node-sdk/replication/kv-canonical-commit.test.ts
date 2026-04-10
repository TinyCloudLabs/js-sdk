import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  kvStateFromPeer,
  openKvReplicationSession,
  reconCompareFromPeer,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication KV Canonical Commit", () => {
  test(
    "keeps replica-authored KV writes visible locally while canonical state catches up through authority reconciliation",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster({
        nodes: [
          { name: "node-a", role: "authority", port: 8010 },
          { name: "node-b", role: "host", port: 8011 },
          {
            name: "node-c",
            role: "replica",
            port: 8012,
            env: {
              TINYCLOUD_REPLICATION_PEER_SERVING: "true",
            },
          },
        ],
      });
      try {
        const prefix = uniqueReplicationPrefix("kv-canonical-commit");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const downstream = createClusterClient(cluster, "node-b", prefix);
        const authoringReplica = createClusterClient(cluster, "node-c", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const downstreamNode = getClusterNode(cluster, "node-b");
        const authoringNode = getClusterNode(cluster, "node-c");

        await authority.signIn();
        await downstream.signIn();
        await authoringReplica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(downstream.spaceId).toBe(authority.spaceId);
        expect(authoringReplica.spaceId).toBe(authority.spaceId);

        const scope = `replication/kv-canonical-commit/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const value = {
          owner: "alice",
          stage: "replica-local",
          createdAt: new Date().toISOString(),
        };

        const writeResult = await authoringReplica.kv.put(key, value);
        expect(writeResult.ok).toBe(true);

        const localGet = await authoringReplica.kv.get<typeof value>(key);
        expect(localGet.ok).toBe(true);
        if (!localGet.ok) {
          throw new Error(localGet.error.message);
        }
        expect(localGet.data.data).toEqual(value);

        const localList = await authoringReplica.kv.list({ prefix: scope });
        expect(localList.ok).toBe(true);
        if (!localList.ok) {
          throw new Error(localList.error.message);
        }
        expect(localList.data.keys).toContain(key);

        const authoritySession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const replicaSession = await openKvReplicationSession(
          authoringReplica,
          authoringNode.url,
          scope
        );

        const authorityStateBefore = await kvStateFromPeer(
          cluster,
          "node-a",
          {
            spaceId: authority.spaceId!,
            prefix: scope,
            keys: [key],
          },
          authoritySession
        );
        expect(authorityStateBefore.items).toHaveLength(1);
        expect(authorityStateBefore.items[0]?.status).toBe("absent");

        const authorityReconBefore = await reconCompareFromPeer(
          cluster,
          "node-a",
          {
            peerUrl: authoringNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          { target: authoritySession, peer: replicaSession }
        );
        expect(authorityReconBefore.matches).toBe(false);
        expect(authorityReconBefore.localItemCount).toBe(0);
        expect(authorityReconBefore.peerItemCount).toBeGreaterThan(0);

        const authorityCatchup = await reconcileFromPeer(
          cluster,
          "node-a",
          {
            peerUrl: authoringNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          { target: authoritySession, peer: replicaSession }
        );
        expect(authorityCatchup.appliedSequences).toBeGreaterThan(0);
        expect(authorityCatchup.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("authority sees replica-authored KV write", async () => {
          const result = await authority.kv.get<typeof value>(key);
          return result.ok && result.data.data.stage === value.stage;
        });

        const authorityRead = await authority.kv.get<typeof value>(key);
        expect(authorityRead.ok).toBe(true);
        if (!authorityRead.ok) {
          throw new Error(authorityRead.error.message);
        }
        expect(authorityRead.data.data).toEqual(value);

        const downstreamSession = await openKvReplicationSession(
          downstream,
          downstreamNode.url,
          scope
        );
        const downstreamCatchup = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          { target: downstreamSession, peer: authoritySession }
        );
        expect(downstreamCatchup.appliedSequences).toBeGreaterThan(0);
        expect(downstreamCatchup.appliedEvents).toBeGreaterThan(0);

        await waitForCondition("downstream sees canonical KV write", async () => {
          const result = await downstream.kv.get<typeof value>(key);
          return result.ok && result.data.data.stage === value.stage;
        });

        const downstreamRead = await downstream.kv.get<typeof value>(key);
        expect(downstreamRead.ok).toBe(true);
        if (!downstreamRead.ok) {
          throw new Error(downstreamRead.error.message);
        }
        expect(downstreamRead.data.data).toEqual(value);

        const downstreamRecon = await reconCompareFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            prefix: scope,
          },
          { target: downstreamSession, peer: authoritySession }
        );
        expect(downstreamRecon.matches).toBe(true);
      } finally {
        await cluster.stop();
      }
    }
  );
});
