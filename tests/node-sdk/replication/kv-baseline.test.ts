import { describe, expect, test } from "bun:test";
import { startCluster } from "./cluster";
import {
  createClusterClient,
  uniqueReplicationPrefix,
} from "./helpers";

describe("Replication KV Baseline", () => {
  test(
    "round-trips KV data through a live node with the real SDK",
    { timeout: 600_000 },
    async () => {
      const cluster = await startCluster();
      try {
        const prefix = uniqueReplicationPrefix("kv-baseline");
        const alice = createClusterClient(cluster, "node-a", prefix);
        await alice.signIn();

        const key = "replication/kv-baseline/profile.json";
        const value = {
          name: "Alice",
          role: "authority-writer",
          createdAt: new Date().toISOString(),
        };

        const putResult = await alice.kv.put(key, value);
        expect(putResult.ok).toBe(true);

        const getResult = await alice.kv.get<typeof value>(key);
        expect(getResult.ok).toBe(true);
        if (!getResult.ok) {
          throw new Error(getResult.error.message);
        }
        expect(getResult.data.data).toEqual(value);

        const listResult = await alice.kv.list({
          prefix: "replication/kv-baseline",
        });
        expect(listResult.ok).toBe(true);
        if (!listResult.ok) {
          throw new Error(listResult.error.message);
        }
        expect(listResult.data.keys).toContain(key);

        const deleteResult = await alice.kv.delete(key);
        expect(deleteResult.ok).toBe(true);

        const missingResult = await alice.kv.get(key);
        expect(missingResult.ok).toBe(false);
        if (missingResult.ok) {
          throw new Error("Expected deleted key lookup to fail");
        }
        expect(missingResult.error.code).toBe("KV_NOT_FOUND");
      } finally {
        await cluster.stop();
      }
    }
  );
});
