import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  openTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Auth Revocation", () => {
  test(
    "rejects an existing replication transport session after its sync delegation is revoked",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("auth-revocation");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const hostAccess = createClusterClient(cluster, "node-b", prefix);
        const hostNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await hostAccess.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(hostAccess.spaceId).toBe(authority.spaceId);

        const scope = `replication/auth-revocation/${Date.now()}`;
        const key = `${scope}/profile.json`;
        const putResult = await authority.kv.put(key, {
          owner: "alice",
          source: "node-a",
          createdAt: new Date().toISOString(),
        });
        expect(putResult.ok).toBe(true);

        const hostSession = await openKvReplicationSession(
          authority,
          hostNode.url,
          scope
        );
        const hostTransport = await openTransportSession(hostSession);
        const initialExport = await fetch(`${hostNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": hostTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: authority.spaceId,
            prefix: scope,
          }),
        });
        expect(initialExport.status).toBe(200);

        const revokeResult = await hostAccess.revokeDelegation(
          hostSession.delegationCid
        );
        expect(revokeResult.ok).toBe(true);

        const revokedExport = await fetch(`${hostNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": hostTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: authority.spaceId,
            prefix: scope,
          }),
        });
        expect(revokedExport.status).toBe(401);
        expect(await revokedExport.text()).toContain("no longer active");
      } finally {
        await cluster.stop();
      }
    }
  );
});
