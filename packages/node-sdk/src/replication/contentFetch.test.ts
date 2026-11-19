import { describe, expect, test } from "bun:test";
import { ServiceContext, type KVReplicaHandle, type KVReplicaSpec, type KVReplicaStorage, type ReplicationScheduler } from "@tinycloud/sdk-services";
import { createMemoryPendingStore } from "@tinycloud/sdk-services/kv/replication";
import type { ReplicationOptions, ServiceSession } from "@tinycloud/sdk-core";
import { assertValidReplicationConfig } from "./config";
import { ReplicationRuntime } from "./runtime";

const address = "0x0000000000000000000000000000000000000001";
const primarySpace = `tinycloud:pkh:eip155:1:${address}:default`;
const session: ServiceSession = {
  delegationHeader: { Authorization: "Bearer session" },
  delegationCid: "bafySession",
  spaceId: primarySpace,
  verificationMethod: "did:key:zSession",
  jwk: {},
};
const clock: ReplicationScheduler = { now: () => 1_700_000_000_000, setTimeout: () => () => undefined };
const enabled = { enabled: true, storage: {}, prefixes: ["notes/"] };

describe("replication.contentFetch validation", () => {
  test("accepts undefined, eager and lazy", () => {
    for (const contentFetch of [undefined, "eager", "lazy"] as const) {
      expect(() => assertValidReplicationConfig({ ...enabled, contentFetch })).not.toThrow();
    }
  });

  test("any other value is a TypeError naming replication.contentFetch, enabled or not", () => {
    for (const contentFetch of ["Lazy", "", "none", 1, null, true] as const) {
      const config = { ...enabled, contentFetch } as unknown as ReplicationOptions;
      expect(() => assertValidReplicationConfig(config)).toThrow(TypeError);
      expect(() => assertValidReplicationConfig(config)).toThrow(/replication\.contentFetch/);
      expect(() => assertValidReplicationConfig({ ...config, enabled: false })).toThrow(/replication\.contentFetch/);
    }
  });
});

describe("ReplicationRuntime contentFetch", () => {
  async function openedSpec(options: Partial<ReplicationOptions>): Promise<KVReplicaSpec> {
    const opened: KVReplicaSpec[] = [];
    const storage: KVReplicaStorage = {
      kind: "sqlite",
      async open(spec) {
        opened.push(spec);
        return {
          spec,
          deviceDid: "did:key:replica",
          async grant() { return { cid: "installed", parentCid: null, expiresAt: null, state: "active", unconstrained: true }; },
          async sync({ syncStartEpoch }) {
            return { status: "synced", pages: 0, changes: 0, deleted: 0, fetched: 0, contentMissing: 0, coverage: "complete", syncedThroughEpoch: syncStartEpoch };
          },
          async close() {},
        } as unknown as KVReplicaHandle;
      },
      async purge() {},
      pendingWrites(identity) { return Object.assign(createMemoryPendingStore(identity), { durable: true }); },
    };
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes/"], storage, mode: "foreground", ...options }, clock);
    await runtime.bind({
      context: new ServiceContext({ invoke: async () => ({} as never), hosts: ["https://node.example"], fetch: async () => new Response("not used") }),
      session,
      address,
      chainId: 1,
      authority: {
        sessionOnly: true,
        sessionGrant: () => ({ ucan: "current-session", device: { did: "did:key:replica", jwk: {} } }),
        plan: () => { throw new Error("session-only authority must not plan"); },
        mint: async () => { throw new Error("session-only authority must not mint"); },
      },
      primaryKV: [],
    });
    await runtime.control.sync();
    await runtime.control.close();
    expect(opened).toHaveLength(1);
    return opened[0]!;
  }

  test("defaults to eager and hands lazy to the storage handle", async () => {
    expect((await openedSpec({})).contentFetch).toBe("eager");
    expect((await openedSpec({ contentFetch: "eager" })).contentFetch).toBe("eager");
    expect((await openedSpec({ contentFetch: "lazy" })).contentFetch).toBe("lazy");
  });
});
