import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import type { PortableDelegation } from "@tinycloud/node-sdk/core";

// Browser globals the web SDK touches at import/construct time.
Object.assign(globalThis, {
  HTMLElement: class {
    attachShadow() {
      return { innerHTML: "", querySelector: () => null };
    }
    remove() {}
  },
  customElements: { define: () => undefined, get: () => undefined },
  window: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    location: { hostname: "test.local" },
  },
  document: {
    createElement: () => ({
      setAttribute: () => undefined,
      appendChild: () => undefined,
      remove: () => undefined,
      style: {},
    }),
    body: { appendChild: () => undefined, style: {} },
  },
});

const BOB_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000BB";
const OWNER = "0x0000000000000000000000000000000000000001";

let events: string[] = [];

// The signed session grants KV read on the whole default space.
const grantedRecap = [{
  service: "kv",
  space: "default",
  path: "/",
  actions: ["tinycloud.kv/get"],
}];

mock.module("@tinycloud/web-sdk-wasm", () => ({
  initialized: Promise.resolve(),
  tinycloud: {
    computeCid: () => "bafk-test",
    ensureEip55: (address: string) => address,
    makeSpaceId: (address: string, chainId: number, prefix: string) =>
      `tinycloud:pkh:eip155:${chainId}:${address}:${prefix}`,
    createDelegation: () => {
      events.push("sign");
      return {
        delegation: "web-ucan-delegation",
        cid: "bafyweb",
        delegateDid: BOB_DID,
        expiry: Math.floor((Date.now() + 3600_000) / 1000),
        resources: [{
          service: "kv",
          space: "space://web",
          path: "items/",
          actions: ["tinycloud.kv/get"],
        }],
      };
    },
    parseRecapFromSiwe: () => grantedRecap,
    // BrowserWasmBindings always routes through the caveat-preserving parser.
    parseVerifiedRecapFromSiwe: () => grantedRecap,
    generateHostSIWEMessage: () => "",
    siweToDelegationHeaders: () => ({}),
    protocolVersion: () => 1,
    vault_encrypt: () => new Uint8Array(),
    vault_decrypt: () => new Uint8Array(),
    vault_derive_key: () => new Uint8Array(),
    vault_x25519_from_seed: () => new Uint8Array(),
    vault_x25519_dh: () => new Uint8Array(),
    vault_random_bytes: (length: number) => new Uint8Array(length),
    vault_sha256: () => new Uint8Array(),
  },
  tcwSession: {
    TCWSessionManager: class {
      createSessionKey(id: string) { return id; }
      replaceSessionKey(_jwk: object, keyId: string) { return keyId; }
      listSessionKeys() { return ["default"]; }
      renameSessionKeyId() {}
      getDID(keyId: string) { return `did:key:${keyId}`; }
      jwk() {
        return JSON.stringify({
          kty: "OKP",
          crv: "Ed25519",
          x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
      }
    },
  },
}));

// Dynamic import: a static import would hoist above `mock.module`, loading the
// real WASM bindings before the mock is registered.
const { TinyCloudWeb } = await import("../src/modules/tcw");

const siwe = [
  "example.com wants you to sign in with your Ethereum account:",
  OWNER,
  "",
  "Sign-in statement",
  "",
  "URI: https://example.com",
  "Version: 1",
  "Chain ID: 1",
  "Nonce: abcdefghij",
  "Issued At: 2024-01-01T00:00:00.000Z",
  `Expiration Time: ${new Date(Date.now() + 7 * 86_400_000).toISOString()}`,
].join("\n");

/**
 * A TinyCloudWeb whose real underlying TinyCloudNode holds a session that
 * covers the requested KV read, so `delegateTo` takes the session-key path.
 */
async function makeSignedInWeb(): Promise<InstanceType<typeof TinyCloudWeb>> {
  const tcw = new TinyCloudWeb();
  // `_initPromise` and `_node` are private; the test reaches the real node
  // to install a session instead of driving a wallet sign-in.
  const internals = tcw as unknown as { _initPromise: Promise<void>; _node: object };
  await internals._initPromise;
  Object.assign(internals._node, {
    auth: {
      tinyCloudSession: {
        address: OWNER,
        chainId: 1,
        sessionKey: "default",
        spaceId: "space://web",
        delegationCid: "bafyparent",
        delegationHeader: { Authorization: "Bearer parent" },
        verificationMethod: "did:key:z6MkWebSession",
        jwk: { kty: "OKP", crv: "Ed25519", x: "test" },
        siwe,
        signature: "0xfake",
      },
    },
  });
  return tcw;
}

const permission = {
  service: "tinycloud.kv",
  space: "default",
  path: "items/",
  actions: ["tinycloud.kv/get"],
};

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  events = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    events.push(`fetch:${String(input)}`);
    return new Response(JSON.stringify({ activated: [], skipped: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("tcw.delegateTo runs onPrepared with the returned delegation before activation", async () => {
  const tcw = await makeSignedInWeb();
  let prepared: PortableDelegation | undefined;

  const result = await tcw.delegateTo(BOB_DID, [permission], {
    onPrepared: async (delegation) => {
      events.push(`hook:${delegation.cid}`);
      prepared = delegation;
    },
  });

  expect(prepared).toBe(result.delegation);
  expect(result.delegation.cid).toBe("bafyweb");
  expect(events.slice(0, 2)).toEqual(["sign", "hook:bafyweb"]);
  expect(events).toHaveLength(3);
  expect(events[2]).toMatch(/^fetch:.*\/delegate$/);
});

test("tcw.delegateTo rejects with the onPrepared error and never activates", async () => {
  const tcw = await makeSignedInWeb();
  const failure = new Error("inventory write failed");

  await expect(
    tcw.delegateTo(BOB_DID, [permission], {
      onPrepared: async () => {
        events.push("hook");
        throw failure;
      },
    }),
  ).rejects.toBe(failure);

  expect(events).toEqual(["sign", "hook"]);
});
