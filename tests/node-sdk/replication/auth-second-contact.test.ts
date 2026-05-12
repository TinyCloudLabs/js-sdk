import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openAuthReplicationSession,
  openKvReplicationSession,
  reconcileAuthFromPeer,
  requestTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Auth Second Contact", () => {
  test(
    "opens a fresh replication session without supporting delegations after auth sync",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("auth-second-contact");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const hostNode = getClusterNode(cluster, "node-b");
        await authority.signIn();
        expect(authority.spaceId).toBeDefined();

        const peerAuthSession = await openAuthReplicationSession(
          authority,
          authorityNode.url
        );
        const targetAuthSession = await openAuthReplicationSession(
          authority,
          hostNode.url
        );
        const authApply = await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: targetAuthSession,
            peer: peerAuthSession,
          }
        );

        expect(authApply.importedDelegations).toBeGreaterThan(0);

        const secondContactScope = `replication/auth-second-contact/fresh/${Date.now()}`;
        const hostSession = await openKvReplicationSession(
          authority,
          hostNode.url,
          secondContactScope
        );
        const secondContactOpen = await requestTransportSession(hostSession, {
          supportingDelegations: null,
        });

        expect(secondContactOpen).toBeDefined();
        expect(secondContactOpen?.status).toBe(200);
        const secondContactTransport = await secondContactOpen!.json();
        expect(secondContactTransport.service).toBe("kv");
        expect(secondContactTransport.prefix).toBe(secondContactScope);
      } finally {
        await cluster.stop();
      }
    }
  );
});
