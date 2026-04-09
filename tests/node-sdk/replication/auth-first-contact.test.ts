import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  openTransportSession,
  requestTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Auth First Contact", () => {
  test(
    "opens a replication session on a peer the user has not signed into yet",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("auth-first-contact");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const hostNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        expect(authority.spaceId).toBeDefined();

        const scope = `replication/auth-first-contact/${Date.now()}`;
        const hostSession = await openKvReplicationSession(
          authority,
          hostNode.url,
          scope
        );

        const missingSupportingChain = await requestTransportSession(hostSession, {
          supportingDelegations: null,
        });
        expect(missingSupportingChain?.status).toBe(401);

        const hostTransport = await openTransportSession(hostSession);
        expect(hostTransport?.service).toBe("kv");
        expect(hostTransport?.prefix).toBe(scope);
        expect(typeof hostTransport?.sessionToken).toBe("string");
        expect((hostTransport?.sessionToken.length ?? 0)).toBeGreaterThan(0);
      } finally {
        await cluster.stop();
      }
    }
  );
});
