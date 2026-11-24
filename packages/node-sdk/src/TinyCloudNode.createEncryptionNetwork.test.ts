import "../../operations/test-support/test-bootstrap.mjs";
/**
 * `createEncryptionNetwork` reads the network first, without signing: an
 * existing network is returned as it is and no `network.create` is signed or
 * sent. The invocation signer (WASM) and the node are stubbed.
 */
import { createHash } from "node:crypto";
import { afterEach, expect, mock, test } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";

import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const HOST = "https://tinycloud.test";
const NODE_DID = "did:key:z6MkNodeUnderTest111111111111111111111111111";
const NETWORK_ID = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;
const DESCRIPTOR = { networkId: NETWORK_ID, name: "default", state: "active" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeNode() {
  const node = new TinyCloudNode({
    host: HOST,
    tinycloudRegistryUrl: HOST,
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: mock(async () => "0xsig"),
    } as never,
    wasmBindings: {
      makeSpaceId: (address: string, chainId: number, name: string) =>
        `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
      protocolVersion: () => 1,
      vault_sha256: (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest()),
      createSessionManager: (): ISessionManager =>
        ({
          createSessionKey: (id: string) => id,
          getDID: (keyId: string) => `did:key:${keyId}`,
          jwk: () => JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "test" }),
        }) as unknown as ISessionManager,
    } as unknown as IWasmBindings,
  });
  const internals = node as unknown as Record<string, unknown>;
  internals._address = ADDRESS;
  internals._chainId = 1;
  internals.auth = {
    tinyCloudSession: {
      address: ADDRESS,
      chainId: 1,
      delegationCid: "bafy-delegation",
      delegationHeader: { Authorization: "token" },
      spaceId: `tinycloud:pkh:eip155:1:${ADDRESS}:default`,
    },
  };
  const signRaw = mock(async () => ({ authorization: "Bearer signed", invocationCid: "bafy-invocation" }));
  internals.signRawNetworkAuthorization = signRaw;
  internals.encryptionDestination = async () => ({ url: HOST, nodeDid: NODE_DID });
  return { node, signRaw };
}

function nodeFetch(networkExists: boolean, seen: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url}`);
    if (method === "GET" && url === `${HOST}/encryption/networks/${encodeURIComponent(NETWORK_ID)}`) {
      return networkExists ? Response.json({ descriptor: DESCRIPTOR }) : new Response(null, { status: 404 });
    }
    if (method === "POST" && url === `${HOST}/encryption/networks`) {
      return Response.json({ descriptor: DESCRIPTOR });
    }
    return new Response("unexpected request", { status: 400 });
  }) as typeof fetch;
}

test("an existing network is returned without signing or sending network.create", async () => {
  const { node, signRaw } = makeNode();
  const seen: string[] = [];
  globalThis.fetch = nodeFetch(true, seen);

  expect(await node.createEncryptionNetwork("default")).toEqual(DESCRIPTOR as never);
  expect(signRaw).not.toHaveBeenCalled();
  expect(seen).toEqual([`GET ${HOST}/encryption/networks/${encodeURIComponent(NETWORK_ID)}`]);
});

test("a missing network is created with one signed network.create", async () => {
  const { node, signRaw } = makeNode();
  const seen: string[] = [];
  globalThis.fetch = nodeFetch(false, seen);

  expect(await node.createEncryptionNetwork("default")).toEqual(DESCRIPTOR as never);
  expect(signRaw).toHaveBeenCalledTimes(1);
  expect(seen.filter((request) => request.startsWith("POST "))).toEqual([`POST ${HOST}/encryption/networks`]);
});
