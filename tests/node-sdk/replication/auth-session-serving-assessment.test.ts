import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Session Serving Assessment", () => {
  test(
    "reports canExport and role state from replication/session/open",
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("replication-session-serving");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-c", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-c");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/session-serving/${Date.now()}`;

        const hostSession = await authority.openReplicationSession({
          host: authorityNode.url,
          scope: {
            service: "kv",
            prefix: scope,
          },
        });
        const replicaSession = await replica.openReplicationSession({
          host: replicaNode.url,
          scope: {
            service: "kv",
            prefix: scope,
          },
        });

        const hostTransport = await openTransportSession(hostSession);
        const replicaTransport = await openTransportSession(replicaSession);

        expect(hostTransport?.serverDid).toBeDefined();
        expect(replicaTransport?.serverDid).toBeDefined();
        expect(hostTransport?.serverDid.length ?? 0).toBeGreaterThan(0);
        expect(replicaTransport?.serverDid.length ?? 0).toBeGreaterThan(0);
        expect(replicaTransport?.serverDid).not.toBe(hostTransport?.serverDid);

        expect(hostTransport?.rolesEnabled).toEqual(["host"]);
        expect(replicaTransport?.rolesEnabled).toEqual(["replica"]);
        expect(hostTransport?.canExport).toBe(true);
        expect(hostTransport?.peerServing).toBe(true);
        expect(replicaTransport?.canExport).toBe(false);
        expect(replicaTransport?.peerServing).toBe(false);
        expect(typeof hostTransport?.recon).toBe("boolean");
        expect(typeof hostTransport?.authSync).toBe("boolean");
        expect(typeof replicaTransport?.recon).toBe("boolean");
        expect(typeof replicaTransport?.authSync).toBe("boolean");
      } finally {
        await cluster.stop();
      }
    }
  );
});
