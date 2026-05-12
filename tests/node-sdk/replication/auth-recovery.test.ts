import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  openTransportSession,
  reconcileFromPeer,
  uniqueReplicationPrefix,
  waitForCondition,
} from "./helpers";

describe("Replication Auth Recovery", () => {
  test(
    "requires both local and peer replication sessions for reconcile pull-through",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("replication-reconcile-auth");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/auth-recovery/reconcile/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const putResult = await authority.kv.put(key, {
          createdAt: new Date().toISOString(),
        });
        expect(putResult.ok).toBe(true);

        const peerSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          scope
        );
        const targetSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scope
        );
        const openedPeerSession = await openTransportSession(peerSession);
        const openedTargetSession = await openTransportSession(targetSession);

        const unauthorized = await fetch(`${replicaNode.url}/replication/reconcile`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId,
            prefix: scope,
          }),
        });
        expect(unauthorized.status).toBe(401);

        const missingPeerSession = await fetch(
          `${replicaNode.url}/replication/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Replication-Session": openedTargetSession!.sessionToken,
            },
            body: JSON.stringify({
              peerUrl: authorityNode.url,
              spaceId: authority.spaceId,
              prefix: scope,
            }),
          }
        );
        expect(missingPeerSession.status).toBe(401);
        expect(await missingPeerSession.text()).toContain(
          "missing Peer-Replication-Session"
        );

        const missingTargetSession = await fetch(
          `${replicaNode.url}/replication/reconcile`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Peer-Replication-Session": openedPeerSession!.sessionToken,
            },
            body: JSON.stringify({
              peerUrl: authorityNode.url,
              spaceId: authority.spaceId,
              prefix: scope,
            }),
          }
        );
        expect(missingTargetSession.status).toBe(401);
      } finally {
        await cluster.stop();
      }
    }
  );

  test(
    "preserves node-c authored KV facts during authority outage and converges after reconnect",
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
        const prefix = uniqueReplicationPrefix("replication-authority-outage");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const host = createClusterClient(cluster, "node-b", prefix);
        const authoringReplica = createClusterClient(cluster, "node-c", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const hostNode = getClusterNode(cluster, "node-b");
        const replicaNode = getClusterNode(cluster, "node-c");

        await authority.signIn();
        await host.signIn();
        await authoringReplica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(host.spaceId).toBe(authority.spaceId);
        expect(authoringReplica.spaceId).toBe(authority.spaceId);

        const scope = `replication/auth-recovery/outage/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const value = {
          owner: "alice",
          stage: "authority-outage",
          createdAt: new Date().toISOString(),
        };

        await cluster.stopNode("node-a");

        const writeResult = await authoringReplica.kv.put(key, value);
        expect(writeResult.ok).toBe(true);

        const localReplicaCanonical = await authoringReplica.kv.get<typeof value>(key);
        expect(localReplicaCanonical.ok).toBe(false);
        if (localReplicaCanonical.ok) {
          throw new Error("Expected canonical replica read to stay absent during authority outage");
        }
        expect(localReplicaCanonical.error.code).toBe("KV_NOT_FOUND");

        const localReplicaGet = await authoringReplica.kv.get<typeof value>(key, {
          readMode: "provisional",
        });
        expect(localReplicaGet.ok).toBe(true);
        if (!localReplicaGet.ok) {
          throw new Error(localReplicaGet.error.message);
        }
        expect(localReplicaGet.data.data).toEqual(value);

        const hostBefore = await host.kv.get(key);
        expect(hostBefore.ok).toBe(false);
        if (hostBefore.ok) {
          throw new Error(
            "Expected node-b to miss the node-c-authored write during authority outage"
          );
        }
        expect(hostBefore.error.code).toBe("KV_NOT_FOUND");

        await cluster.startNode("node-a");

        const restartedAuthority = createClusterClient(cluster, "node-a", prefix);
        await restartedAuthority.signIn();
        expect(restartedAuthority.spaceId).toBe(authoringReplica.spaceId);

        const authorityTargetSession = await openKvReplicationSession(
          restartedAuthority,
          authorityNode.url,
          scope
        );
        const replicaPeerSession = await openKvReplicationSession(
          authoringReplica,
          replicaNode.url,
          scope
        );
        const authorityCatchup = await reconcileFromPeer(
          cluster,
          "node-a",
          {
            peerUrl: replicaNode.url,
            spaceId: restartedAuthority.spaceId!,
            prefix: scope,
          },
          {
            target: authorityTargetSession,
            peer: replicaPeerSession,
          }
        );
        expect(authorityCatchup.appliedSequences).toBeGreaterThan(0);
        expect(authorityCatchup.appliedEvents).toBeGreaterThan(0);

        await waitForCondition(
          "authority sees node-c-authored KV after reconnect",
          async () => {
            const result = await restartedAuthority.kv.get<typeof value>(key);
            return result.ok && result.data.data.stage === "authority-outage";
          }
        );

        const hostTargetSession = await openKvReplicationSession(
          host,
          hostNode.url,
          scope
        );
        const authorityPeerSession = await openKvReplicationSession(
          restartedAuthority,
          authorityNode.url,
          scope
        );
        const hostCatchup = await reconcileFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: restartedAuthority.spaceId!,
            prefix: scope,
          },
          {
            target: hostTargetSession,
            peer: authorityPeerSession,
          }
        );
        expect(hostCatchup.appliedSequences).toBeGreaterThan(0);
        expect(hostCatchup.appliedEvents).toBeGreaterThan(0);

        await waitForCondition(
          "node-b converges after authority reconnect",
          async () => {
            const result = await host.kv.get<typeof value>(key);
            return result.ok && result.data.data.stage === "authority-outage";
          }
        );

        const convergedHostGet = await host.kv.get<typeof value>(key);
        expect(convergedHostGet.ok).toBe(true);
        if (!convergedHostGet.ok) {
          throw new Error(convergedHostGet.error.message);
        }
        expect(convergedHostGet.data.data).toEqual(value);
      } finally {
        await cluster.stop();
      }
    }
  );
});
