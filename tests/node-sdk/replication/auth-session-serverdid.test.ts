import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Session Server Identity", () => {
  test(
    "surfaces a per-space serverDid from replication/session/open",
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("replication-session-serverdid");
        const authority = createClusterClient(cluster, "node-a", prefix);
        const replica = createClusterClient(cluster, "node-b", prefix);
        const authorityNode = getClusterNode(cluster, "node-a");
        const replicaNode = getClusterNode(cluster, "node-b");

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const scope = `replication/session-serverdid/${Date.now()}`;

        const authorityAuthoritySession = await authority.openReplicationSession({
          host: authorityNode.url,
          scope: {
            service: "kv",
            prefix: scope,
          },
        });
        const replicaAuthoritySession = await replica.openReplicationSession({
          host: authorityNode.url,
          scope: {
            service: "kv",
            prefix: scope,
          },
        });
        const replicaReplicaSession = await replica.openReplicationSession({
          host: replicaNode.url,
          scope: {
            service: "kv",
            prefix: scope,
          },
        });

        const authorityTransport = await openTransportSession(
          authorityAuthoritySession
        );
        const authorityTransportFromReplica = await openTransportSession(
          replicaAuthoritySession
        );
        const replicaTransport = await openTransportSession(replicaReplicaSession);

        expect(typeof authorityTransport?.serverDid).toBe("string");
        expect(authorityTransport?.serverDid.length ?? 0).toBeGreaterThan(0);
        expect(authorityTransportFromReplica?.serverDid).toBe(
          authorityTransport?.serverDid
        );
        expect(replicaTransport?.serverDid).toBeDefined();
        expect(replicaTransport?.serverDid).not.toBe(authorityTransport?.serverDid);
      } finally {
        await cluster.stop();
      }
    }
  );
});
