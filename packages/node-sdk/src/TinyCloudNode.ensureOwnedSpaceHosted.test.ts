import { expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const SECRETS = `tinycloud:pkh:eip155:1:${ADDRESS}:secrets`;

function makeSessionManager(): ISessionManager {
  return {
    createSessionKey: (id: string) => id,
    renameSessionKeyId: () => {},
    getDID: (keyId: string) => `did:key:${keyId}`,
    jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
  };
}

function makeWasmBindings(): IWasmBindings {
  return {
    invoke: async () => undefined,
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    createSessionManager: makeSessionManager,
  } as unknown as IWasmBindings;
}

function makeNode(): TinyCloudNode {
  const signer = {
    getAddress: async () => ADDRESS,
    getChainId: async () => 1,
    signMessage: mock(async () => "0xsig"),
  };
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: signer as any,
    wasmBindings: makeWasmBindings(),
  });
  // Simulate post-signIn state.
  (node as any)._address = ADDRESS;
  (node as any)._chainId = 1;
  (node as any).auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "base-token" },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    },
  };
  return node;
}

/**
 * Override the account registry so `ensureOwnedSpaceHosted`'s registry check
 * (`account.index.spaces.list()` fast path, then canonical
 * `account.spaces.get(spaceId)`) returns a deterministic result. `register` is
 * a no-op spy so the post-host durable write does not blow up.
 */
function stubAccountRegistry(
  node: TinyCloudNode,
  opts: {
    indexList?: ReturnType<typeof mock>;
    get?: ReturnType<typeof mock>;
  },
): void {
  const indexList =
    opts.indexList ?? mock(async () => ({ ok: true as const, data: [] }));
  const get =
    opts.get ??
    mock(async () => ({
      ok: false as const,
      error: { code: "KV_NOT_FOUND", message: "Key not found", service: "kv" },
    }));
  (node as any)._account = {
    index: { spaces: { list: indexList } },
    spaces: { get, register: mock(async () => ({ ok: true as const, data: {} })) },
  };
}

test("ensureOwnedSpaceHosted does NOT host when the SQLite index already lists the space", async () => {
  const node = makeNode();
  const indexList = mock(async () => ({
    ok: true as const,
    data: [
      { spaceId: SECRETS, name: "secrets", ownerDid: "", type: "owned", permissions: ["*"], status: "active" },
    ],
  }));
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  // Index hit => no host-SIWE prompt; canonical KV read not even needed.
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

test("ensureOwnedSpaceHosted does NOT host when the canonical KV record exists (index empty)", async () => {
  const node = makeNode();
  // Index has no rows; canonical `account/spaces/{id}` KV record is present.
  const indexList = mock(async () => ({ ok: true as const, data: [] }));
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted hosts when neither index nor canonical KV lists the space", async () => {
  const node = makeNode();
  const indexList = mock(async () => ({ ok: true as const, data: [] }));
  const get = mock(async () => ({
    ok: false as const,
    error: { code: "KV_NOT_FOUND", message: "Key not found", service: "kv" },
  }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpace).toHaveBeenCalledTimes(1);
  expect(hostOwnedSpace).toHaveBeenCalledWith("secrets");
});

test("ensureOwnedSpaceHosted falls back to canonical KV when the index THROWS (no such table: spaces)", async () => {
  const node = makeNode();
  // Cold SQLite index surfaces `no such table: spaces` as a throw.
  const indexList = mock(async () => {
    throw new Error("no such table: spaces");
  });
  // Canonical KV record exists => still no host.
  const get = mock(async () => ({ ok: true as const, data: {} }));
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  // The cache error must NOT throw; canonical KV hit avoided the host.
  expect(hostOwnedSpace).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted hosts (does not throw) when the entire registry check THROWS", async () => {
  const node = makeNode();
  const indexList = mock(async () => {
    throw new Error("no such table: spaces");
  });
  const get = mock(async () => {
    throw new Error("kv exploded");
  });
  stubAccountRegistry(node, { indexList, get });

  const hostOwnedSpace = mock(async () => SECRETS);
  (node as any).hostOwnedSpace = hostOwnedSpace;

  // Must not throw the cache/KV error: falls through to hosting.
  const spaceId = await node.ensureOwnedSpaceHosted("secrets");

  expect(spaceId).toBe(SECRETS);
  expect(hostOwnedSpace).toHaveBeenCalledTimes(1);
});

test("ensureOwnedSpaceHosted throws when not signed in", async () => {
  const node = new TinyCloudNode({
    host: "https://tinycloud.test",
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: async () => "0xsig",
    } as any,
    wasmBindings: makeWasmBindings(),
  });
  await expect(node.ensureOwnedSpaceHosted("secrets")).rejects.toThrow(
    "Not signed in",
  );
});
