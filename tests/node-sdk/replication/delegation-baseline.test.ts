import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication Delegation Baseline", () => {
  test(
    "creates a live delegation on one node and uses it from another",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("delegation-baseline");
        const alice = createClusterClient(cluster, "node-a", prefix);
        const bob = createClusterClient(cluster, "node-b", prefix);

        await alice.signIn();
        await bob.signIn();

        expect(alice.spaceId).toBeDefined();
        expect(bob.spaceId).toBeDefined();
        expect(alice.spaceId).toBe(bob.spaceId);

        const sharedPath = `replication/delegation-baseline/${Date.now()}`;
        const delegation = await alice.createDelegation({
          path: sharedPath,
          actions: [
            "tinycloud.kv/get",
            "tinycloud.kv/put",
            "tinycloud.kv/list",
            "tinycloud.kv/metadata",
          ],
          delegateDID: bob.did,
          includePublicSpace: false,
        });

        const delegatedAccess = await bob.useDelegation(delegation);
        expect(delegatedAccess.spaceId).toBe(alice.spaceId);
        expect(delegatedAccess.path).toBe(sharedPath);

        const noteKey = "message.txt";
        const noteValue = {
          owner: "alice",
          writer: "bob",
          sharedAt: new Date().toISOString(),
        };

        const putResult = await delegatedAccess.kv.put(noteKey, noteValue);
        expect(putResult.ok).toBe(true);

        const delegatedGet = await delegatedAccess.kv.get<typeof noteValue>(noteKey);
        expect(delegatedGet.ok).toBe(true);
        if (!delegatedGet.ok) {
          throw new Error(delegatedGet.error.message);
        }
        expect(delegatedGet.data.data).toEqual(noteValue);

        const aliceGet = await alice.kv.get<typeof noteValue>(
          `${sharedPath}/${noteKey}`
        );
        expect(aliceGet.ok).toBe(true);
        if (!aliceGet.ok) {
          throw new Error(aliceGet.error.message);
        }
        expect(aliceGet.data.data).toEqual(noteValue);

        const listResult = await delegatedAccess.kv.list();
        expect(listResult.ok).toBe(true);
        if (!listResult.ok) {
          throw new Error(listResult.error.message);
        }
        expect(listResult.data.keys).toContain(`${sharedPath}/${noteKey}`);
      } finally {
        await cluster.stop();
      }
    }
  );
});
