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

    const release = Promise.withResolvers<void>();
    const activationStarted = Promise.withResolvers<void>();
    globalThis.fetch = mock(async () => {
      activationStarted.resolve();
      await release.promise;
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
    release.resolve();

    await expect(pending).rejects.toThrow("retired");
    await signedOut;
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });
});

/** A wallet signer whose next signature (once gated) waits until `release()`. */
function gatedSigner() {
  const inner = new PrivateKeySigner(OWNER_KEY);
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let gated = false;
  return {
    signer: {
      getAddress: () => inner.getAddress(),
      getChainId: () => inner.getChainId(),
      signMessage: async (message: string | Uint8Array) => {
        if (gated) {
          gated = false;
          started.resolve();
          await gate.promise;
        }
        return inner.signMessage(message);
      },
    },
    gateNextSignatures: () => { gated = true; },
    signing: started.promise,
    release: () => gate.resolve(),
  };
}

describe("TinyCloudNode.signOut during an in-flight sign-in or restore", () => {
  test("a restore that started before sign-out does not establish its session", async () => {
    recordRequests();
    const node = new TinyCloudNode({
      host: HOST,
      signer: new PrivateKeySigner(OWNER_KEY),
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
    });
    const restoring = node.restoreSession(await signedSession());
    await node.signOut();

    await expect(restoring).rejects.toThrow("cancelled by sign-out");
    expect(node.restorableSession).toBeUndefined();
    expect(() => node.kv).toThrow("Not signed in");
    expect(requests).toEqual([]);
  });

  test("a sign-in still persisting its session when sign-out runs is undone", async () => {
    requests = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const body = url.endsWith("/info")
        ? { protocol: 1, version: "test", features: [], nodeId: "did:key:z6MkNode" }
        : { activated: [], skipped: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const saving = Promise.withResolvers<void>();
    const releaseSave = Promise.withResolvers<void>();
    class SlowStorage extends MemorySessionStorage {
      override async save(...args: Parameters<MemorySessionStorage["save"]>): Promise<void> {
        saving.resolve();
        await releaseSave.promise;
        return super.save(...args);
      }
    }
    const sessionStorage = new SlowStorage();
    const node = new TinyCloudNode({
      host: HOST,
      signer: new PrivateKeySigner(OWNER_KEY),
      wasmBindings: new NodeWasmBindings(),
      sessionStorage,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      autoCreateSpace: false,
    });
    const signingIn = node.signIn();
    signingIn.catch(() => undefined);
    await saving.promise;
    await node.signOut();
    const requestsAtSignOut = requests.length;
    releaseSave.resolve();

    await expect(signingIn).rejects.toThrow("cancelled by sign-out");
    // The cancelled sign-in never published its session or made another request.
    expect(requests.length).toBe(requestsAtSignOut);
    expect(node.session).toBeUndefined();
    expect(node.restorableSession).toBeUndefined();
    expect(sessionStorage.exists(await new PrivateKeySigner(OWNER_KEY).getAddress())).toBe(false);
  });

  test("a cancelled sign-in does not end a session restored after the sign-out", async () => {
    recordRequests();
    const inner = new PrivateKeySigner(OWNER_KEY);
    const lookup = Promise.withResolvers<void>();
    const releaseLookup = Promise.withResolvers<void>();
    let holdLookup = true;
    const node = new TinyCloudNode({
      host: HOST,
      signer: {
        getAddress: async () => {
          if (holdLookup) {
            holdLookup = false;
            lookup.resolve();
            await releaseLookup.promise;
          }
          return inner.getAddress();
        },
        getChainId: () => inner.getChainId(),
        signMessage: (message: string | Uint8Array) => inner.signMessage(message),
      },
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
    });
    const signingIn = node.signIn();
    signingIn.catch(() => undefined);
    await lookup.promise;
    await node.signOut();
    const proof = await signedSession();
    await node.restoreSession(proof);
    releaseLookup.resolve();

    await expect(signingIn).rejects.toThrow("cancelled by sign-out");
    expect(node.restorableSession?.delegationCid).toBe(proof.delegationCid);
    const before = requests.length;
    await node.kv.get("notes/a");
    expect(requests.length).toBeGreaterThan(before);
  });

  test("a delegated request in flight is aborted by sign-out", async () => {
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
    const requested = Promise.withResolvers<AbortSignal | undefined>();
    globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      requested.resolve(init?.signal ?? undefined);
      const response = Promise.withResolvers<Response>();
      init?.signal?.addEventListener("abort", () => response.reject(new DOMException("aborted", "AbortError")), { once: true });
      return response.promise;
    }) as unknown as typeof fetch;

    const pending = access.kv.get("notes/a");
    const signal = await requested.promise;
    await node.signOut();

    expect(signal?.aborted).toBe(true);
    const result = await pending.catch(() => ({ ok: false }));
    expect(result.ok).toBe(false);
  });

  test("a runtime grant whose wallet signature finishes after sign-out is never activated", async () => {
    const proof = await signedSession();
    const gated = gatedSigner();
    const node = new TinyCloudNode({
      host: HOST,
      signer: gated.signer,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
    });
    await node.restoreSession(proof);
    recordRequests();
    gated.gateNextSignatures();

    const granting = node.grantRuntimePermissions([
      { service: "tinycloud.kv", space: "photos", path: "albums/", actions: ["tinycloud.kv/get"] },
    ]);
    await gated.signing;
    await node.signOut();
    gated.release();

    await expect(granting).rejects.toThrow("retired");
    expect(requests).toEqual([]);
    expect(node.getRuntimePermissionDelegations()).toEqual([]);
  });

  test("a sign-in waiting on the wallet across sign-out and a new sign-in does not end the new session", async () => {
    requests = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const body = url.endsWith("/info")
        ? { protocol: 1, version: "test", features: [], nodeId: "did:key:z6MkNode" }
        : { activated: [], skipped: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const gated = gatedSigner();
    const node = new TinyCloudNode({
      host: HOST,
      signer: gated.signer,
      wasmBindings: new NodeWasmBindings(),
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      autoCreateSpace: false,
    });
    gated.gateNextSignatures();
    const first = node.signIn();
    first.catch(() => undefined);
    await gated.signing;
    await node.signOut();
    await node.signIn();
    const second = node.restorableSession?.delegationCid;
    gated.release();

    await expect(first).rejects.toThrow("Sign-in was cancelled by sign-out.");
    expect(node.restorableSession?.delegationCid).toBe(second);
    const before = requests.length;
    await node.kv.get("notes/a");
    expect(requests.length).toBeGreaterThan(before);
  });

  test("a cancelled sign-in's save cleanup keeps a newer sign-in's persisted session", async () => {
    requests = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      requests.push(url);
      const body = url.endsWith("/info")
        ? { protocol: 1, version: "test", features: [], nodeId: "did:key:z6MkNode" }
        : { activated: [], skipped: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const firstWrite = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<void>();
    let delayAck = true;
    // The first save lands immediately but its acknowledgment is held.
    class SlowAckStorage extends MemorySessionStorage {
      override async save(...args: Parameters<MemorySessionStorage["save"]>): Promise<void> {
        await super.save(...args);
        if (delayAck) {
          delayAck = false;
          firstWrite.resolve();
          await ack.promise;
        }
      }
    }
    const sessionStorage = new SlowAckStorage();
    const inner = new PrivateKeySigner(OWNER_KEY);
    let signatures = 0;
    const secondSignature = Promise.withResolvers<void>();
    const node = new TinyCloudNode({
      host: HOST,
      signer: {
        getAddress: () => inner.getAddress(),
        getChainId: () => inner.getChainId(),
        signMessage: async (message: string | Uint8Array) => {
          const signature = await inner.signMessage(message);
          if (++signatures === 2) secondSignature.resolve();
          return signature;
        },
      },
      wasmBindings: new NodeWasmBindings(),
      sessionStorage,
      autoBootstrapAccount: false,
      includeAccountRegistryPermissions: false,
      enablePublicSpace: false,
      autoCreateSpace: false,
    });
    const address = await inner.getAddress();

    const first = node.signIn();
    first.catch(() => undefined);
    await firstWrite.promise;
    await node.signOut();
    const second = node.signIn();
    // Let the second sign-in reach its own save before the first resumes.
    await secondSignature.promise;
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await tick.promise;
    ack.resolve();

    await expect(first).rejects.toThrow("Sign-in was cancelled by sign-out.");
    await second;
    expect(node.session).toBeDefined();
    expect(sessionStorage.exists(address)).toBe(true);
    expect((await sessionStorage.load(address))?.siwe).toBe(node.session?.siwe);
  });
});
