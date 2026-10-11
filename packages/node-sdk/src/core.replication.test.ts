import { afterEach, expect, test } from "bun:test";
import type { TinyCloudNodeConfig } from "./TinyCloudNode";
import { registerReplicationLoaders, TinyCloudNode } from "./core";
import type { ReplicationModuleLoaders } from "./replication/module-registry";

const storage = {
  kind: "sqlite" as const,
  async open() { throw new Error("status must not open storage"); },
  async purge() {},
};

function loaders(): ReplicationModuleLoaders {
  return {
    runtime: () => import("./replication/runtime"),
    authority: () => import("./replication/authority"),
  };
}

afterEach(() => registerReplicationLoaders(loaders()));

test("/core enables replication when browser-safe controller loaders are registered", async () => {
  let runtimeLoads = 0;
  class InjectedRuntime {
    readonly control = {
      status: async () => [{ prefix: "notes" }],
      sync: async () => {},
      purge: async () => ({ purged: [], failed: [] }),
      clearPending: async () => 0,
      close: async () => {},
    };
    constructor(_options: unknown) {}
  }
  registerReplicationLoaders({
    runtime: async () => {
      runtimeLoads++;
      return { ReplicationRuntime: InjectedRuntime } as never;
    },
    authority: async () => import("./replication/authority"),
  });

  const wasmBindings = {
    createSessionManager: () => ({
      createSessionKey: (id: string) => id,
      getDID: (id: string) => `did:key:${id}`,
      jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "synthetic" }),
    }),
  } as never;
  const node = new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["notes"], storage },
  } satisfies TinyCloudNodeConfig);

  expect(await node.replication?.status()).toEqual([{ prefix: "notes" }]);
  expect(runtimeLoads).toBe(1);
});
