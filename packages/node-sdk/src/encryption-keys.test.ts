/**
 * Wiring of the named-key client onto a real TinyCloudNode: the client must sign
 * through the node's raw invocation signer with the EXACT key URN as the single
 * resource, hash admin bodies like the network-admin invocation does, and stay
 * dark on nodes without `encryption-named-keys-v1`. Request-level behavior is
 * covered in sdk-services; the invocation signer itself (WASM) is stubbed.
 * NOT run against a real node.
 */
import { createHash } from "node:crypto";
import { expect, mock, test, type Mock } from "bun:test";

import type { ISessionManager, IWasmBindings } from "@tinycloud/sdk-core";
import { canonicalizeEncryptionJson } from "@tinycloud/sdk-services";
import type { InlineEncryptedEnvelope } from "@tinycloud/sdk-services";

import { createNamedKeyClient } from "./encryption-keys";
import { TinyCloudNode } from "./TinyCloudNode";

const ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const HOST = "https://tinycloud.test";
const NODE_DID = "did:key:z6MkNodeUnderTest111111111111111111111111111";
const DID = `did:pkh:eip155:1:${ADDRESS}`;
const NETWORK_ID = `urn:tinycloud:encryption:${DID}:default`;
const PATH = "apps/tinychat/session";
const KEY_URN = `${NETWORK_ID}/${PATH}`;

const sha256Hex = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function makeWasmBindings(): IWasmBindings {
  return {
    invoke: async () => undefined,
    invokeAny: async () => ({}),
    makeSpaceId: (address: string, chainId: number, name: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${name}`,
    generateHostSIWEMessage: mock(() => ""),
    siweToDelegationHeaders: mock(() => ({})),
    protocolVersion: () => 1,
    vault_sha256: (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest()),
    vault_encrypt: mock(() => new Uint8Array()),
    vault_decrypt: mock(() => new Uint8Array()),
    vault_derive_key: mock(() => new Uint8Array()),
    vault_random_bytes: mock(() => new Uint8Array(32)),
    vault_x25519_from_seed: mock(() => ({ publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) })),
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

interface Stubbed {
  node: TinyCloudNode;
  signRaw: Mock<(input: unknown) => Promise<{ authorization: string; invocationCid: string }>>;
}

function makeNode(): Stubbed {
  const node = new TinyCloudNode({
    host: HOST,
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: mock(async () => "0xsig"),
    } as never,
    wasmBindings: makeWasmBindings(),
  });
  const internals = node as unknown as {
    _address: string;
    _chainId: number;
    auth: unknown;
    signRawNetworkAuthorization: unknown;
  };
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
    nodeIdForHost: (host: string) => (host === HOST ? NODE_DID : undefined),
  };
  const signRaw = mock(async () => ({
    authorization: "Bearer signed",
    invocationCid: "bafy-invocation",
  }));
  internals.signRawNetworkAuthorization = signRaw;
  return { node, signRaw };
}

interface Seen {
  method: string;
  url: string;
  body?: string;
}

function recordingFetch(features: string[], seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url === `${HOST}/info`) {
      return new Response(JSON.stringify({ nodeId: NODE_DID, features }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        networkId: NETWORK_ID,
        keyPath: PATH,
        alg: "x25519-aes256gcm/v1",
        keyVersion: 1,
        publicEncryptionKey: "AAAA",
        state: "active",
        kind: "deterministic",
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

test("createKey signs one key.create capability on the exact key URN and hashes the body like network-admin", async () => {
  const { node, signRaw } = makeNode();
  const seen: Seen[] = [];
  const client = createNamedKeyClient(node, {
    fetch: recordingFetch(["encryption-named-keys-v1"], seen),
  });

  await client.createKey(PATH);

  expect(signRaw).toHaveBeenCalledTimes(1);
  const call = signRaw.mock.calls[0]![0] as {
    targetNode: string;
    networkId: string;
    action: string;
    facts: Record<string, unknown>;
  };
  // The signer's resource slot carries the exact key URN, not the network id.
  expect(call.networkId).toBe(KEY_URN);
  expect(call.action).toBe("tinycloud.encryption/key.create");
  expect(call.targetNode).toBe(NODE_DID);

  const post = seen.find((r) => r.method === "POST")!;
  expect(post.url).toBe(`${HOST}/encryption/networks/${NETWORK_ID}/keys`);
  expect(post.url).not.toContain("%");
  expect(post.body).toBe('{"deletable":true,"keyPath":"apps/tinychat/session"}');
  expect(call.facts).toEqual({
    type: "tinycloud.encryption.key-admin/v1",
    targetNode: NODE_DID,
    networkId: NETWORK_ID,
    keyPath: PATH,
    action: "tinycloud.encryption/key.create",
    // Same rule createEncryptionNetwork uses: sha256 over the canonical body it sends.
    bodyHash: sha256Hex(canonicalizeEncryptionJson({ keyPath: PATH, deletable: true })),
  });
  expect(call.facts.bodyHash).toBe(sha256Hex(post.body!));
});

test("network-admin and key-admin facts hash their sent bodies with the same rule", async () => {
  const { node, signRaw } = makeNode();
  const original = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ descriptor: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await node.createEncryptionNetwork("default");
  } finally {
    globalThis.fetch = original;
  }
  const facts = (signRaw.mock.calls[0]![0] as { facts: { bodyHash: string } }).facts;
  expect(facts.bodyHash).toBe(sha256Hex(sent[0]!));
});

test("a node without the named-keys feature gets /info only: no key request, no signing", async () => {
  const { node, signRaw } = makeNode();
  const seen: Seen[] = [];
  const client = createNamedKeyClient(node, { fetch: recordingFetch(["sql"], seen) });

  await expect(client.ensureKey(PATH)).rejects.toMatchObject({ code: "NAMED_KEYS_UNSUPPORTED" });
  await expect(client.createKey(PATH)).rejects.toMatchObject({ code: "NAMED_KEYS_UNSUPPORTED" });

  expect(seen.map((r) => r.url)).toEqual([`${HOST}/info`, `${HOST}/info`]);
  expect(signRaw).not.toHaveBeenCalled();
});

test("v1 envelopes decrypt through the node's existing root-key service, with no key request", async () => {
  const { node, signRaw } = makeNode();
  const decryptEnvelope = mock(async () => ({ ok: true as const, data: new Uint8Array([1, 2, 3]) }));
  Object.defineProperty(node, "encryption", { value: { decryptEnvelope } });
  const seen: Seen[] = [];
  const client = createNamedKeyClient(node, { fetch: recordingFetch([], seen) });
  const v1: InlineEncryptedEnvelope = {
    v: 1,
    networkId: NETWORK_ID,
    alg: "x25519-aes256gcm/v1",
    keyVersion: 1,
    encryptedSymmetricKey: "AA==",
    encryptedSymmetricKeyHash: "h",
    ciphertext: "AA==",
  };

  expect(await client.decrypt(v1)).toEqual(new Uint8Array([1, 2, 3]));
  expect(decryptEnvelope).toHaveBeenCalledWith(v1, { proofs: ["bafy-delegation"] });
  expect(seen).toHaveLength(0);
  expect(signRaw).not.toHaveBeenCalled();
});

test("createNamedKeyClient resolves both signing hooks on an unstubbed TinyCloudNode", () => {
  // A rename of either private hook on TinyCloudNode fails here, not in production.
  const node = new TinyCloudNode({
    host: HOST,
    signer: {
      getAddress: async () => ADDRESS,
      getChainId: async () => 1,
      signMessage: mock(async () => "0xsig"),
    } as never,
    wasmBindings: makeWasmBindings(),
  });
  const hooks = node as unknown as Record<string, unknown>;
  expect(typeof hooks.signRawNetworkAuthorization).toBe("function");
  expect(typeof hooks.createEncryptionCrypto).toBe("function");
  expect(() => createNamedKeyClient(node)).not.toThrow();
});

test("TinyCloudNode.keys loads the named-key client when first used", async () => {
  const { node } = makeNode();
  const seen: Seen[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = recordingFetch(["encryption-named-keys-v1"], seen);
  try {
    const descriptor = await node.keys.describeKey(PATH);
    expect(descriptor.keyPath).toBe(PATH);
    expect(seen[0]?.url).toBe(`${HOST}/info`);
    expect(seen.some((call) => call.url.includes("/keys/") && call.method === "GET")).toBe(true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a node missing a hook throws a typed error naming it", () => {
  for (const hook of ["signRawNetworkAuthorization", "createEncryptionCrypto"]) {
    const { node } = makeNode();
    Object.defineProperty(node, hook, { value: undefined });
    let thrown: unknown;
    try {
      createNamedKeyClient(node);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: "NamedKeyError", code: "NODE_HOOK_MISSING" });
    expect((thrown as Error).message).toContain(hook);
  }
});
