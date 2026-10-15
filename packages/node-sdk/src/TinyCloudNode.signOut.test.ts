import { afterEach, describe, expect, mock, test } from "bun:test";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { MemorySessionStorage } from "./storage/MemorySessionStorage";
import { TinyCloudNode } from "./TinyCloudNode";

const HOST = "https://signout.test";
const OWNER_KEY = "4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f";

async function signedSession() {
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
  return {
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
  };
}

const originalFetch = globalThis.fetch;
let requests: string[] = [];

function recordRequests(): void {
  requests = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function expectNoAuthorizedCall(call: () => Promise<unknown>): Promise<void> {
  const before = requests.length;
  let failed = false;
  try {
    const result = await call();
    failed = typeof result === "object" && result !== null && "ok" in result && result.ok === false;
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  expect(requests.length).toBe(before);
}

describe.each([
  ["wallet", true],
  ["walletless", false],
] as const)("TinyCloudNode.signOut after a %s restore", (_label, withSigner) => {
  test("ends the in-memory session on the instance", async () => {
    recordRequests();
    const proof = await signedSession();
    const sessionStorage = new MemorySessionStorage();
    const node = new TinyCloudNode({
      host: HOST,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      sessionStorage,
      ...(withSigner ? { signer: new PrivateKeySigner(OWNER_KEY) } : {}),
    });
    await node.restoreSession(proof);
    await sessionStorage.save(proof.address, {
      address: proof.address,
      chainId: proof.chainId,
      sessionKey: JSON.stringify(proof.jwk),
      siwe: proof.siwe,
      signature: proof.signature,
      expiresAt: proof.expiresAt,
      createdAt: new Date().toISOString(),
      version: "1.0",
    });

    const kv = node.kv;
    const sessionDid = node.sessionDid;
    expect(node.restorableSession?.delegationCid).toBe(proof.delegationCid);
    await kv.get("notes/a");
    expect(requests.length).toBeGreaterThan(0);

    await node.signOut();

    expect(node.session).toBeUndefined();
    expect(node.restorableSession).toBeUndefined();
    expect(node.address).toBeUndefined();
    expect(() => node.kv).toThrow("Not signed in");
    expect(() => node.invokeAny([{ service: "kv", spaceId: proof.spaceId, path: "notes/a", action: "tinycloud.kv/get" }])).toThrow("Not signed in");
    expect(node.sessionDid).not.toBe(sessionDid);
    await expectNoAuthorizedCall(() => kv.get("notes/a"));
    await expectNoAuthorizedCall(() => kv.put("notes/b", "after sign-out"));
    expect(sessionStorage.exists(proof.address)).toBe(false);

    // Signing out twice is harmless.
    await node.signOut();
    expect(node.restorableSession).toBeUndefined();
  });

  test("can restore a session again after signing out", async () => {
    recordRequests();
    const proof = await signedSession();
    const node = new TinyCloudNode({
      host: HOST,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      ...(withSigner ? { signer: new PrivateKeySigner(OWNER_KEY) } : {}),
    });
    await node.restoreSession(proof);
    await node.signOut();
    await node.restoreSession(proof);

    expect(node.restorableSession?.delegationCid).toBe(proof.delegationCid);
    const before = requests.length;
    await node.kv.get("notes/a");
    expect(requests.length).toBeGreaterThan(before);
  });
});

describe("TinyCloudNode.signIn after signOut", () => {
  function stubNode(): void {
    requests = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const body = url.endsWith("/info")
        ? { protocol: 1, version: "test", features: [], nodeId: "did:key:z6MkNode" }
        : { activated: [], skipped: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  function walletNode(): TinyCloudNode {
    return new TinyCloudNode({
      host: HOST,
      signer: new PrivateKeySigner(OWNER_KEY),
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      autoCreateSpace: false,
    });
  }

  async function expectUsableSession(node: TinyCloudNode): Promise<void> {
    expect(node.restorableSession).toBeDefined();
    const before = requests.length;
    await node.kv.get("notes/a");
    expect(requests.length).toBeGreaterThan(before);
  }

  test("a signed-in instance can sign in again after signing out", async () => {
    stubNode();
    const node = walletNode();
    await node.signIn();
    const firstCid = node.restorableSession?.delegationCid;
    await node.signOut();
    await node.signIn();
    await expectUsableSession(node);
    expect(node.restorableSession?.delegationCid).not.toBe(firstCid);
  });

  test("a restored instance can sign in after signing out", async () => {
    stubNode();
    const node = walletNode();
    await node.restoreSession(await signedSession());
    await node.signOut();
    await node.signOut();
    await node.signIn();
    await expectUsableSession(node);
  });
});

describe("TinyCloudNode.signOut and delegated authority", () => {
  test("a useDelegation() result stops signing after sign-out", async () => {
    recordRequests();
    const proof = await signedSession();
    const node = new TinyCloudNode({
      host: HOST,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
    });
    const access = await node.useDelegation({
      cid: proof.delegationCid,
      delegationHeader: proof.delegationHeader,
      spaceId: proof.spaceId,
      path: "notes/",
      actions: ["tinycloud.kv/get"],
      expiry: new Date(Date.now() + 60 * 60_000),
      delegateDID: node.did,
      ownerAddress: proof.address,
      chainId: proof.chainId,
      host: HOST,
    });
    await access.kv.get("notes/a");
    expect(requests.length).toBeGreaterThan(0);

    await node.signOut();

    await expectNoAuthorizedCall(() => access.kv.get("notes/a"));
  });

  test("a runtime grant activated across sign-out is not installed", async () => {
    const proof = await signedSession();
    const node = new TinyCloudNode({
      host: HOST,
      signer: new PrivateKeySigner(OWNER_KEY),
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
    });
    await node.restoreSession(proof);

    let releaseActivation!: () => void;
    const activationStarted = Promise.withResolvers<void>();
    globalThis.fetch = mock(async () => {
      activationStarted.resolve();
      await new Promise<void>((resolve) => { releaseActivation = resolve; });
      return new Response(JSON.stringify({ activated: [], skipped: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const pending = node.useRuntimeDelegation({
      cid: "bafy-runtime-grant",
      delegationHeader: { Authorization: "Bearer runtime-grant" },
      spaceId: proof.spaceId,
      path: "photos/",
      actions: ["tinycloud.kv/get"],
      expiry: new Date(Date.now() + 60 * 60_000),
      delegateDID: proof.verificationMethod,
      ownerAddress: proof.address,
      chainId: proof.chainId,
      host: HOST,
    });
    await activationStarted.promise;
    const signedOut = node.signOut();
    releaseActivation();

    await expect(pending).rejects.toThrow("retired");
    await signedOut;
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });
});
