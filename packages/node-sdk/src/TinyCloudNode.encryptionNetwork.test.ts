/** Public encryption-network HTTP behavior on a genuine-no-entry route. */
import { expect, mock, test } from "bun:test";

import { authorizationVerdictOf, type ISessionManager, type IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const HOST = "https://tinycloud.test";
const NODE_DID = "did:key:z6MkNodeUnderTest111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDRESS}`;
const NETWORK_ID = `urn:tinycloud:encryption:${DID}:default`;

const DESCRIPTOR = {
  networkId: NETWORK_ID,
  ownerDid: DID,
  name: "default",
  alg: "x25519",
  keyVersion: 1,
  publicKey: "AAAA",
  state: "active",
};

function makeWasmBindings(): IWasmBindings {
  return {
    invoke: async () => undefined,
    invokeAny: async () => ({}),
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_sha256: mock(() => new Uint8Array(32)),
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array(32)),
    vault_x25519_from_seed: mock(() => ({
      publicKey: new Uint8Array(32),
      privateKey: new Uint8Array(32),
    })),
    vault_x25519_dh: mock(() => new Uint8Array(32)),
    createSessionManager: (): ISessionManager =>
      ({
        createSessionKey: (id: string) => id,
        replaceSessionKey: (_jwk: object, keyId: string) => keyId,
        renameSessionKeyId: () => {},
        getDID: (keyId: string) => `did:key:${keyId}`,
        jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
      }) as unknown as ISessionManager,
  } as unknown as IWasmBindings;
}

function makeNode(options: { cachedNodeIdHost?: string } = {}): TinyCloudNode {
  const node = new TinyCloudNode({
    host: HOST,
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: mock(async () => "0xsig"),
    } as any,
    wasmBindings: makeWasmBindings(),
  });
  (node as any)._address = ADDRESS;
  (node as any)._chainId = 1;
  (node as any).auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationHeader: { Authorization: "token" },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    },
    // Mirrors NodeUserAuthorization.nodeIdForHost: only answers for the host
    // whose /info produced the value.
    nodeIdForHost: (host: string) =>
      host === options.cachedNodeIdHost ? NODE_DID : undefined,
    resolveResourceDestinations: async () => [{ url: HOST }],
  };
  // Keep this fixture focused on descriptor/admin HTTP behavior.
  (node as any).signRawNetworkAuthorization = mock(async () => ({
    authorization: "Bearer signed-admin-invocation",
    invocationCid: "bafy-invocation",
  }));
  return node;
}

interface Recorded {
  method: string;
  url: string;
}

/**
 * Stub `fetch` with a small router and record every request, so tests assert
 * on the exact wire sequence rather than on internal call counts.
 */
function withRecordedFetch<T>(
  handler: (method: string, url: string) => Response | undefined,
  fn: (recorded: Recorded[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const recorded: Recorded[] = [];
  globalThis.fetch = mock(async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    recorded.push({ method, url });
    const response = handler(method, url);
    if (!response) throw new Error(`unexpected fetch: ${method} ${url}`);
    return response;
  }) as unknown as typeof fetch;
  return fn(recorded).finally(() => {
    globalThis.fetch = original;
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("activeNodeIdentity exposes the registry-resolved origin joined to that Node's cached DID", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    () => undefined,
    async () => {
      await expect(node.activeNodeIdentity()).resolves.toEqual({ origin: HOST, nodeDid: NODE_DID });
    },
  );
});

test("creates the owner network when the caller knows it is missing", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) =>
      method === "POST" && url === `${HOST}/encryption/networks`
        ? json({ descriptor: DESCRIPTOR }, 201)
        : undefined,
    async () => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID, {
        assumeMissing: true,
      });

      expect(descriptor).toEqual(DESCRIPTOR);
    },
  );
});

test("409 Conflict is treated as success and resolved to the existing network", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) => {
      if (method === "POST" && url === `${HOST}/encryption/networks`) {
        // The only Conflict this route produces is NetworkAlreadyExists.
        return new Response("network already exists", { status: 409 });
      }
      if (method === "GET" && url.startsWith(`${HOST}/encryption/networks/`)) {
        return json({ descriptor: DESCRIPTOR });
      }
      return undefined;
    },
    async () => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID, {
        assumeMissing: true,
      });

      expect(descriptor).toEqual(DESCRIPTOR);
    },
  );
});

test("a non-409 create failure still throws", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) =>
      method === "POST" && url === `${HOST}/encryption/networks`
        ? new Response("not authorized", { status: 401 })
        : undefined,
    async () => {
      await expect(
        node.ensureEncryptionNetwork(NETWORK_ID, { assumeMissing: true }),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
});

test("returns an existing network descriptor without trying to create it", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) =>
      method === "GET" && url.startsWith(`${HOST}/encryption/networks/`)
        ? json({ descriptor: DESCRIPTOR })
        : undefined,
    async () => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID);

      expect(descriptor).toEqual(DESCRIPTOR);
    },
  );
});

test("node-info and encryption network HTTP failures keep typed status and authorization verdict", async () => {
  for (const [stage, status, body, verdict] of [
    ["info", 401, "", "unauthenticated"],
    ["probe", 403, "Unauthorized Action: denied", "forbidden"],
    ["create", 403, "Forbidden", "forbidden"],
    ["create", 500, "session expired", "other"],
  ] as const) {
    const node = makeNode(stage === "info" ? {} : { cachedNodeIdHost: HOST });
    await withRecordedFetch(
      (method, url) => {
        if (stage === "info" && method === "GET" && url === `${HOST}/info`) {
          return new Response(body, { status });
        }
        if (stage === "probe" && method === "GET" && url.startsWith(`${HOST}/encryption/networks/`)) {
          return new Response(body, { status });
        }
        if (stage === "create" && method === "POST" && url === `${HOST}/encryption/networks`) {
          return new Response(body, { status });
        }
        return undefined;
      },
      async () => {
        try {
          if (stage === "info") await node.activeNodeIdentity();
          else if (stage === "probe") await node.getEncryptionNetwork(NETWORK_ID);
          else await node.ensureEncryptionNetwork(NETWORK_ID, { assumeMissing: true });
          throw new Error("expected HTTP failure");
        } catch (error) {
          expect(error).toMatchObject({ status });
          expect(authorizationVerdictOf(error)).toBe(verdict);
        }
      },
    );
  }
});

test("creates a network whose descriptor endpoint returns 404", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) => {
      if (method === "GET" && url.startsWith(`${HOST}/encryption/networks/`)) {
        return new Response("", { status: 404 });
      }
      if (method === "POST" && url === `${HOST}/encryption/networks`) {
        return json({ descriptor: DESCRIPTOR }, 201);
      }
      return undefined;
    },
    async () => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID);

      expect(descriptor).toEqual(DESCRIPTOR);
    },
  );
});

test("ensureEncryptionNetwork still refuses to create a network owned by someone else", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });
  const foreign = "urn:tinycloud:encryption:did:pkh:eip155:1:0x00000000000000000000000000000000000000ff:default";

  await withRecordedFetch(
    () => undefined,
    async (recorded) => {
      // assumeMissing must not bypass the ownership check.
      await expect(
        node.ensureEncryptionNetwork(foreign, { assumeMissing: true }),
      ).rejects.toThrow();
      expect(recorded).toEqual([]);
    },
  );
});
