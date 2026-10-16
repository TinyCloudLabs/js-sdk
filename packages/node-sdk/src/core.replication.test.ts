import { afterEach, expect, test } from "bun:test";
import type { TinyCloudNodeConfig } from "./TinyCloudNode";
import { getNodeReplicationLoaders, registerReplicationLoaders, TinyCloudNode } from "./core";
import type { ReplicationModuleLoaders } from "./replication/module-registry";
import { assertValidReplicationConfig } from "./replication/config";

const storage = {
  kind: "sqlite" as const,
  async open() { throw new Error("status must not open storage"); },
  async purge() {},
};

function loaders(): ReplicationModuleLoaders {
  return {
    validateConfig: assertValidReplicationConfig,
    runtime: () => import("./replication/runtime"),
    authority: () => import("./replication/authority"),
    gate: () => import("@tinycloud/replica/profile-gate"),
  };
}

const wasmBindings = {
  createSessionManager: () => ({
    createSessionKey: (id: string) => id,
    getDID: (id: string) => `did:key:${id}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "synthetic" }),
  }),
} as never;

afterEach(() => registerReplicationLoaders(loaders()));
test("/core without replication does not register or load replica modules", () => {
  registerReplicationLoaders(undefined as never);
  const node = new TinyCloudNode({
    wasmBindings,
    replication: { enabled: false, prefixes: ["notes/"], storage },
  } satisfies TinyCloudNodeConfig);
  expect(node.replication).toBeUndefined();
  expect(() => getNodeReplicationLoaders()).toThrow("registering replication controller loaders");
});


test("/core validates enabled replication synchronously through its registered loader", () => {
  let validated = 0;
  registerReplicationLoaders({
    ...loaders(),
    validateConfig: (replication) => {
      validated++;
      assertValidReplicationConfig(replication);
    },
  });
  expect(() => new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["notes/"], storage },
  })).not.toThrow();
  expect(validated).toBe(1);
  expect(() => new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["notes/", "notes/sub/"], storage },
  })).toThrow(TypeError);
  expect(() => new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["vault/private/"], storage },
  })).toThrow(TypeError);
  expect(() => new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["notes/"], storage, grantTtlMs: 8 * 24 * 60 * 60 * 1000 },
  })).toThrow(TypeError);
  registerReplicationLoaders(undefined as never);
  expect(() => new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["notes/"], storage },
  })).toThrow("registering replication controller loaders");
});

test("/core enables replication when browser-safe controller loaders are registered", async () => {
  let runtimeLoads = 0;
  class InjectedRuntime {
    readonly control = {
      status: async () => [{ prefix: "notes/" }],
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
    validateConfig: assertValidReplicationConfig,
    authority: async () => import("./replication/authority"),
    gate: async () => import("@tinycloud/replica/profile-gate"),
  });

  const node = new TinyCloudNode({
    wasmBindings,
    replication: { enabled: true, prefixes: ["notes/"], storage },
  } satisfies TinyCloudNodeConfig);

  expect(await node.replication?.status()).toEqual([{ prefix: "notes/" }]);
  expect(runtimeLoads).toBe(1);
});
