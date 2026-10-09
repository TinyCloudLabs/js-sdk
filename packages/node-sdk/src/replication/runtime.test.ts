import { describe, expect, test } from "bun:test";
import { ServiceContext, createMemoryPendingStore, type KVReadThrough, type KVReplicaStorage, type ReplicationScheduler } from "@tinycloud/sdk-services";
import type { ServiceSession } from "@tinycloud/sdk-core";
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
const authority = {
  sessionGrant: () => ({ refused: "NOT_COVERED" as const }),
  plan: () => ({ refused: "NOT_COVERED" as const }),
  async mint() { throw new Error("unexpected mint"); },
};
const clock: ReplicationScheduler = {
  now: () => 1_700_000_000_000,
  setTimeout: () => () => undefined,
};

function context(host: string): ServiceContext {
  return new ServiceContext({
    invoke: async () => ({} as never),
    hosts: [host],
    fetch: async () => new Response("not used"),
  });
}

describe("node ReplicationRuntime binding", () => {
  test("binds by canonical host/session identity and shares pending state on session replacement", async () => {
    let pendingStores = 0;
    const storage = {
      kind: "sqlite",
      async open() { throw new Error("lazy runtime must not open storage during bind"); },
      async purge() {},
      pendingWrites(identity: Parameters<typeof createMemoryPendingStore>[0]) {
        pendingStores++;
        return createMemoryPendingStore(identity);
      },
    } as KVReplicaStorage;
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes"], storage }, clock);
    let attached: KVReadThrough | null = null;
    const kv = { setReadThrough(value: KVReadThrough | null) { attached = value; } };
    const binding = (host: string, delegationCid: string) => ({
      context: context(host),
      session: { ...session, delegationCid },
      address,
      chainId: 1,
      authority,
      primaryKV: [{ space: primarySpace, kv }],
    });

    await runtime.bind(binding("HTTPS://Node.Example:443/", "bafyFirst"));
    expect(attached).not.toBeNull();
    const first = await runtime.control.status();
    expect(first.map((entry) => entry.prefix)).toEqual(["notes"]);
    await runtime.bind(binding("https://node.example", "bafyReplacement"));
    expect(pendingStores).toBe(1);
    expect(await runtime.control.status()).toMatchObject([{ prefix: "notes", pending: { inFlight: 0, committed: 0, ambiguous: 0 } }]);

    runtime.attach("another-space", kv);
    expect(attached).toBeNull();
    runtime.attach(primarySpace, kv);
    expect(attached).not.toBeNull();
    runtime.unbind();
    expect(attached).toBeNull();
    expect(await runtime.control.status()).toEqual([]);
    await runtime.control.sync();
  });

  test("isolates pending stores when the bind host changes", async () => {
    const identities: string[] = [];
    const storage = {
      kind: "sqlite",
      async open() { throw new Error("unexpected open"); },
      async purge() {},
      pendingWrites(identity: Parameters<typeof createMemoryPendingStore>[0]) {
        identities.push(JSON.stringify(identity));
        return createMemoryPendingStore(identity);
      },
    } as KVReplicaStorage;
    const runtime = new ReplicationRuntime({ enabled: true, prefixes: ["notes"], storage }, clock);
    const bind = (host: string) => runtime.bind({
      context: context(host), session, address, chainId: 1, authority,
      primaryKV: [{ space: primarySpace, kv: { setReadThrough() {} } }],
    });

    await bind("https://one.example");
    await bind("https://two.example");
    expect(identities).toHaveLength(2);
    expect(identities[0]).not.toBe(identities[1]);
    expect(JSON.parse(identities[0]!).host).toBe("https://one.example");
    expect(JSON.parse(identities[1]!).host).toBe("https://two.example");
  });
});
