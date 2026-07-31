/**
 * Encryption-network round-trip guards (TC-293 P6).
 *
 * Two cold-path requests removed:
 *   (a) `GET /info` is already performed during sign-in for the protocol
 *       check, and that response carries `nodeId` — so encryption-network
 *       admin invocations reuse it instead of fetching `/info` again.
 *   (b) `ensureEncryptionNetwork` no longer probes
 *       `GET /encryption/networks/{id}` when the caller knows the account was
 *       just bootstrapped (a guaranteed 404). Creating without the probe is
 *       safe because the server answers 409 for an existing network, which is
 *       resolved to the existing descriptor.
 */
import { expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

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
  };
  // Signing an admin invocation is a WASM concern; this suite is about the
  // request sequence, so stub it out.
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

// ---------------------------------------------------------------------------
// (a) nodeId reuse
// ---------------------------------------------------------------------------

test("fetchNodeId reuses the nodeId that sign-in already read from /info", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    () => undefined, // any request at all is a failure
    async (recorded) => {
      const nodeId = await (node as any).fetchNodeId();
      expect(nodeId).toBe(NODE_DID);
      expect(recorded).toEqual([]);
    },
  );
});

test("fetchNodeId falls back to GET /info when sign-in recorded a different host", async () => {
  // Sign-in targeted another node: the cached DID must not be reused here.
  const node = makeNode({ cachedNodeIdHost: "https://other.tinycloud.test" });

  await withRecordedFetch(
    (method, url) =>
      method === "GET" && url === `${HOST}/info`
        ? json({ nodeId: NODE_DID, protocol: 1, version: "1.0.0", features: [] })
        : undefined,
    async (recorded) => {
      const nodeId = await (node as any).fetchNodeId();
      expect(nodeId).toBe(NODE_DID);
      expect(recorded).toEqual([{ method: "GET", url: `${HOST}/info` }]);
    },
  );
});

test("fetchNodeId falls back to GET /info when the node reported no nodeId", async () => {
  // No cached host at all — the auth layer stores nothing when /info omits nodeId.
  const node = makeNode();

  await withRecordedFetch(
    (method, url) =>
      method === "GET" && url === `${HOST}/info`
        ? json({ nodeId: NODE_DID, protocol: 1, version: "1.0.0", features: [] })
        : undefined,
    async (recorded) => {
      expect(await (node as any).fetchNodeId()).toBe(NODE_DID);
      expect(recorded).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// (b) POST-first / 409 handling
// ---------------------------------------------------------------------------

test("assumeMissing skips the existence probe: create is the only request", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) =>
      method === "POST" && url === `${HOST}/encryption/networks`
        ? json({ descriptor: DESCRIPTOR }, 201)
        : undefined,
    async (recorded) => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID, {
        assumeMissing: true,
      });

      expect(descriptor).toEqual(DESCRIPTOR as any);
      // No GET /info and no GET /encryption/networks/{id}: one request total.
      expect(recorded).toEqual([
        { method: "POST", url: `${HOST}/encryption/networks` },
      ]);
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
    async (recorded) => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID, {
        assumeMissing: true,
      });

      expect(descriptor).toEqual(DESCRIPTOR as any);
      expect(recorded.map((r) => r.method)).toEqual(["POST", "GET"]);
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
      ).rejects.toThrow(/Failed to create encryption network .*HTTP 401/);
    },
  );
});

test("without assumeMissing the warm path is unchanged: one GET, no create", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });

  await withRecordedFetch(
    (method, url) =>
      method === "GET" && url.startsWith(`${HOST}/encryption/networks/`)
        ? json({ descriptor: DESCRIPTOR })
        : undefined,
    async (recorded) => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID);

      expect(descriptor).toEqual(DESCRIPTOR as any);
      expect(recorded).toEqual([
        {
          method: "GET",
          url: `${HOST}/encryption/networks/${encodeURIComponent(NETWORK_ID)}`,
        },
      ]);
    },
  );
});

test("without assumeMissing a 404 probe still falls through to create", async () => {
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
    async (recorded) => {
      const descriptor = await node.ensureEncryptionNetwork(NETWORK_ID);

      expect(descriptor).toEqual(DESCRIPTOR as any);
      expect(recorded.map((r) => r.method)).toEqual(["GET", "POST"]);
    },
  );
});

test("ensureEncryptionNetwork still refuses to create a network owned by someone else", async () => {
  const node = makeNode({ cachedNodeIdHost: HOST });
  const foreign = "urn:tinycloud:encryption:did:pkh:eip155:1:0x00000000000000000000000000000000000000ff:default";

  await withRecordedFetch(
    () => undefined,
    async () => {
      // assumeMissing must not bypass the ownership check.
      await expect(
        node.ensureEncryptionNetwork(foreign, { assumeMissing: true }),
      ).rejects.toThrow(/does not match signed-in DID/);
    },
  );
});
