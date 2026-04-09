import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openAuthReplicationSession,
  openKvReplicationSession,
  openTransportSession,
  reconcileAuthFromPeer,
  requestTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Auth Revocation Propagation", () => {
  test(
    "propagates revoked sync delegations across peers through auth sync",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("auth-revocation-propagation");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const hostNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        expect(authority.spaceId).toBeDefined();

        const sharedScope = `replication/auth-revocation-propagation/shared/${Date.now()}`;
        const sharedSession = await openKvReplicationSession(
          authority,
          authorityNode.url,
          sharedScope
        );
        await openTransportSession(sharedSession);

        const bootstrapSession = await openAuthReplicationSession(
          authority,
          authorityNode.url
        );
        const bootstrapTargetSession = await openAuthReplicationSession(
          authority,
          hostNode.url
        );
        const bootstrapApply = await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: bootstrapTargetSession,
            peer: bootstrapSession,
          }
        );

        expect(bootstrapApply.importedDelegations).toBeGreaterThan(0);

        const preRevocationOpen = await requestTransportSession(sharedSession, {
          supportingDelegations: null,
        });
        expect(preRevocationOpen).toBeDefined();
        expect(preRevocationOpen?.status).toBe(200);

        await authority.revokeDelegation(sharedSession.delegationCid);

        const revocationSyncSession = await openAuthReplicationSession(
          authority,
          authorityNode.url
        );
        const revocationTargetSession = await openAuthReplicationSession(
          authority,
          hostNode.url
        );
        const revocationApply = await reconcileAuthFromPeer(
          cluster,
          "node-b",
          {
            peerUrl: authorityNode.url,
            spaceId: authority.spaceId!,
          },
          {
            target: revocationTargetSession,
            peer: revocationSyncSession,
          }
        );

        expect(revocationApply.importedRevocations).toBeGreaterThan(0);

        const postRevocationOpen = await requestTransportSession(sharedSession, {
          supportingDelegations: null,
        });

        expect(postRevocationOpen).toBeDefined();
        expect(postRevocationOpen?.status).toBe(401);
        expect(await postRevocationOpen!.text()).toContain(
          "replication delegation is no longer active"
        );
      } finally {
        await cluster.stop();
      }
    }
  );
});
