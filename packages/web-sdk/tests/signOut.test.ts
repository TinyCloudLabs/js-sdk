import { afterEach, expect, mock, test } from "bun:test";

(globalThis as any).HTMLElement = class {
  attachShadow() {
    return { innerHTML: "", querySelector: () => null };
  }
  remove() {}
};
(globalThis as any).customElements = { define: () => undefined, get: () => undefined };
(globalThis as any).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  location: { hostname: "test.local" },
};
(globalThis as any).document = {
  createElement: () => ({ setAttribute: () => undefined, appendChild: () => undefined, remove: () => undefined, style: {} }),
  body: { appendChild: () => undefined, style: {} },
};

// TinyCloudWeb's own browser bindings are not used for the session under test.
mock.module("@tinycloud/web-sdk-wasm", () => ({
  initialized: Promise.resolve(),
  tinycloud: { protocolVersion: () => 1, ensureEip55: (address: string) => address },
  tcwSession: {
    TCWSessionManager: class {
      createSessionKey(id: string) { return id; }
      replaceSessionKey(_jwk: object, keyId: string) { return keyId; }
      listSessionKeys() { return ["default"]; }
      renameSessionKeyId() {}
      getDID(keyId: string) { return `did:key:${keyId}`; }
      jwk() {
        return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
      }
    },
  },
}));

const { TinyCloudWeb } = require("../src/modules/tcw");
const { TinyCloudNode, NodeWasmBindings, PrivateKeySigner } = require("@tinycloud/node-sdk");

const HOST = "https://signout.test";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

async function restoredNode() {
  const wasm = new NodeWasmBindings();
  const signer = new PrivateKeySigner(OWNER_KEY);
  const manager = wasm.createSessionManager();
  const jwk = JSON.parse(manager.jwk("default")!);
  const address = await signer.getAddress();
  const chainId = await signer.getChainId();
  const spaceId = wasm.makeSpaceId(address, chainId, "default");
  const now = Date.now();
  const expirationTime = new Date(now + 60 * 60_000).toISOString();
  const prepared = wasm.prepareSession({
    abilities: { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put"] } },
    address,
    chainId,
    domain: "signout.test",
    issuedAt: new Date(now).toISOString(),
    expirationTime,
    spaceId,
    jwk,
  });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode({
    host: HOST,
    signer: new PrivateKeySigner(OWNER_KEY),
    wasmBindings: wasm,
    autoBootstrapAccount: false,
  });
  await node.restoreSession({
    delegationHeader: session.delegationHeader,
    delegationCid: session.delegationCid,
    spaceId,
    jwk,
    verificationMethod: manager.getDID("default"),
    address,
    chainId,
    siwe: prepared.siwe,
    signature,
    expiresAt: expirationTime,
    tinycloudHosts: [HOST],
  });
  return node;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("signOut() ends the session on the TinyCloudWeb instance", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const tcw = await TinyCloudWeb.create({});
  // Install a real signed-in session; the browser wallet flow is not under test.
  (tcw as { _node: unknown })._node = await restoredNode();

  const kv = tcw.kv;
  expect(tcw.session()).toBeDefined();
  expect(tcw.accountAuthorizationCid().length).toBeGreaterThan(0);
  await kv.get("notes/a");
  const signedInRequests = requests.length;
  expect(signedInRequests).toBeGreaterThan(0);

  await tcw.signOut();

  expect(tcw.session()).toBeUndefined();
  expect(tcw.address()).toBeUndefined();
  expect(() => tcw.accountAuthorizationCid()).toThrow("Not signed in");
  expect(() => tcw.kv).toThrow("Not signed in");
  let staleCallFailed = false;
  try {
    const result = await kv.put("notes/b", "after sign-out");
    staleCallFailed = result.ok === false;
  } catch {
    staleCallFailed = true;
  }
  expect(staleCallFailed).toBe(true);
  expect(requests.length).toBe(signedInRequests);
});
