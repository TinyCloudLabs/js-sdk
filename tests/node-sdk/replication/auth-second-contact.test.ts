import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  reconcileAuthFromPeer,
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
        const sharedScope = `replication/auth-second-contact/shared/${Date.now()}`;

        await authority.signIn();
        expect(authority.spaceId).toBeDefined();

        const authSyncSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          sharedScope
        );
        const authApply = await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
            service: "kv",
            prefix: sharedScope,
          },
          authSyncSession
        );

        expect(authApply.importedDelegations).toBeGreaterThan(0);

        const secondContactScope = `replication/auth-second-contact/fresh/${Date.now()}`;
        const hostSession = await openKvReplicationSession(
          authority,
          hostNode.url,
          secondContactScope
        );
        const secondContactOpen = await fetch(
          `${hostNode.url}/replication/session/open`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...hostSession.delegationHeader,
            },
            body: JSON.stringify({
              spaceId: authority.spaceId,
              service: "kv",
              prefix: secondContactScope,
            }),
          }
        );

        expect(secondContactOpen.status).toBe(200);
        const secondContactTransport = await secondContactOpen.json();
        expect(secondContactTransport.service).toBe("kv");
        expect(secondContactTransport.prefix).toBe(secondContactScope);
      } finally {
        await cluster.stop();
      }
    }
  );
});
