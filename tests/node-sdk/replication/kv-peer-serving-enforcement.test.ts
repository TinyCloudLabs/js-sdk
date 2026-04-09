import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  getClusterNode,
  openKvReplicationSession,
  openTransportSession,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Peer Serving Enforcement", () => {
  test(
    "allows host export and denies replica export unless peer serving is enabled",
    { timeout: 600_000 },
    async () => {
      const prefix = uniqueReplicationPrefix("peer-serving-default");
      const scope = `replication/peer-serving/default/${Date.now()}`;
      const key = `${scope}/profile.json`;

      const defaultCluster = await startCluster();
      try {
        const host = createClusterClient(defaultCluster, "node-b", prefix);
        const replica = createClusterClient(defaultCluster, "node-c", prefix);
        const hostNode = getClusterNode(defaultCluster, "node-b");
        const replicaNode = getClusterNode(defaultCluster, "node-c");

        const hostInfoResponse = await fetch(`${hostNode.url}/info`);
        const replicaInfoResponse = await fetch(`${replicaNode.url}/info`);
        expect(hostInfoResponse.ok).toBe(true);
        expect(replicaInfoResponse.ok).toBe(true);

        const hostInfo = (await hostInfoResponse.json()) as {
          rolesEnabled: string[];
          replication: { peerServing: boolean };
        };
        const replicaInfo = (await replicaInfoResponse.json()) as {
          rolesEnabled: string[];
          replication: { peerServing: boolean };
        };
        expect(hostInfo.rolesEnabled).toEqual(["host"]);
        expect(hostInfo.replication.peerServing).toBe(true);
        expect(replicaInfo.rolesEnabled).toEqual(["replica"]);
        expect(replicaInfo.replication.peerServing).toBe(false);

        await host.signIn();
        await replica.signIn();

        expect(host.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(host.spaceId);

        const putResult = await host.kv.put(key, {
          owner: "alice",
          relayedBy: "node-b",
          createdAt: new Date().toISOString(),
        });
        expect(putResult.ok).toBe(true);

        const hostSession = await openKvReplicationSession(
          host,
          hostNode.url,
          scope
        );
        const hostTransport = await openTransportSession(hostSession);
        const hostExport = await fetch(`${hostNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": hostTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: host.spaceId,
            prefix: scope,
          }),
        });
        expect(hostExport.status).toBe(200);

        const replicaSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scope
        );
        const replicaTransport = await openTransportSession(replicaSession);
        const replicaExport = await fetch(`${replicaNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": replicaTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: replica.spaceId,
            prefix: scope,
          }),
        });
        expect(replicaExport.status).toBe(403);
        expect(await replicaExport.text()).toContain("peerServing");
      } finally {
        await defaultCluster.stop();
      }

      const enabledCluster = await startCluster({
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
        const authority = createClusterClient(enabledCluster, "node-a", prefix);
        const replica = createClusterClient(enabledCluster, "node-c", prefix);
        const replicaNode = getClusterNode(enabledCluster, "node-c");
        const replicaInfoResponse = await fetch(`${replicaNode.url}/info`);
        expect(replicaInfoResponse.ok).toBe(true);
        const replicaInfo = (await replicaInfoResponse.json()) as {
          rolesEnabled: string[];
          replication: { peerServing: boolean };
        };
        expect(replicaInfo.rolesEnabled).toEqual(["replica"]);
        expect(replicaInfo.replication.peerServing).toBe(true);

        await authority.signIn();
        await replica.signIn();

        expect(authority.spaceId).toBeDefined();
        expect(replica.spaceId).toBe(authority.spaceId);

        const putResult = await replica.kv.put(key, {
          owner: "alice",
          relayedBy: "node-c",
          createdAt: new Date().toISOString(),
        });
        expect(putResult.ok).toBe(true);

        const replicaSession = await openKvReplicationSession(
          replica,
          replicaNode.url,
          scope
        );
        const replicaTransport = await openTransportSession(replicaSession);
        const replicaExport = await fetch(`${replicaNode.url}/replication/export`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Replication-Session": replicaTransport!.sessionToken,
          },
          body: JSON.stringify({
            spaceId: replica.spaceId,
            prefix: scope,
          }),
        });
        expect(replicaExport.status).toBe(200);

        const exportBody = (await replicaExport.json()) as {
          sequences: Array<{ events: Array<unknown> }>;
        };
        expect(exportBody.sequences.length).toBeGreaterThan(0);
        expect(exportBody.sequences[0]?.events.length ?? 0).toBeGreaterThan(0);
      } finally {
        await enabledCluster.stop();
      }
    }
  );
});
