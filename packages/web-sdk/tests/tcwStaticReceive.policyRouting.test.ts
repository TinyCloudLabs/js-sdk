import "./support/browserGlobalsShim";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createPublicKey, verify } from "node:crypto";
import { base58btc } from "multiformats/bases/base58";
import { Wallet } from "ethers";
import {
  createLocalStorageRegistryCacheStore,
  createLocalStorageRegistrySequenceStore,
  pkhDid,
  parseSignedSiweCacao,
  registryOwnerKeyV2,
  signLocationRecordV2,
  type EncodedShareData,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "@tinycloud/node-sdk/core";
import { TinyCloudWeb } from "../src/modules/tcw";
import { BrowserWasmBindings } from "../src/adapters/BrowserWasmBindings";

const nativeFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const NODE_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";
const OTHER_DID = "did:key:z6MkrJVcY6xCzz6qGFmYwNwSuzyLkxEMWrbhtcRbXSRwV7Hn";
const servers: Server<undefined>[] = [];

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const server of servers.splice(0)) server.stop(true);
  restoreGlobal("localStorage", storageDescriptor);
  restoreGlobal("navigator", navigatorDescriptor);
});

function browserStorage() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (
      _name: string,
      optionsOrAction: object | (() => Promise<unknown>),
      action?: () => Promise<unknown>,
    ) => typeof optionsOrAction === "function" ? optionsOrAction() : action!() } },
  });
  return storage;
}

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server.url.origin;
}

function encode(data: EncodedShareData): string {
  return `tc1:${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
}

async function fixture(options: { warm?: boolean; registered?: boolean; wrongIdentity?: boolean; redirect?: "/delegate" | "/invoke"; wrapper?: boolean } = {}) {
  const storage = browserStorage();
  const attempts: Array<{ origin: string; path: string; method: string; authorization: string | null }> = [];
  const remember = (request: Request) => {
    const url = new URL(request.url);
    attempts.push({ origin: url.origin, path: url.pathname, method: request.method, authorization: request.headers.get("authorization") });
  };
  const sink = serve((request) => { remember(request); return Response.json({ leaked: true }); });
  const stale = serve((request) => { remember(request); return new Response("stale host must not receive traffic", { status: 403 }); });
  const routed = serve((request) => {
    remember(request);
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ nodeId: options.wrongIdentity ? OTHER_DID : NODE_DID });
    if (path === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: options.wrongIdentity ? OTHER_DID : NODE_DID });
    if (path === options.redirect) return Response.redirect(`${sink}${path}`, 307);
    if (path === "/delegate") return Response.json({ activated: ["parent"] });
    if (path === "/revoke") return Response.json({ revoked: true });
    if (path === "/invoke") return Response.json({ message: "verified shared data" });
    return new Response("unexpected fixture endpoint", { status: 404 });
  });

  // Synthetic fixture signer; all cryptography and invocations use the browser WASM adapter.
  const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const wasm = new BrowserWasmBindings();
  await wasm.ensureInitialized();
  const manager = wasm.createSessionManager();
  const keyId = manager.createSessionKey("static-receive-parent");
  const keyDid = manager.getDID(keyId);
  const spaceId = `tinycloud:pkh:eip155:1:${owner.address}:applications`;
  const path = "shared/report.json";
  const expiry = new Date(Date.now() + 60 * 60_000);
  const prepared = wasm.prepareSession({
    abilities: {
      kv: { [path]: ["tinycloud.kv/get"] },
      ...(options.wrapper ? { delegation: { "": ["tinycloud.delegation/revoke"] } } : {}),
    },
    address: owner.address, chainId: 1, domain: "static-receive.test",
    issuedAt: new Date().toISOString(), expirationTime: expiry.toISOString(), spaceId, delegateUri: keyDid,
  });
  const signature = await owner.signMessage(prepared.siwe);
  const parent = wasm.completeSessionSetup({ ...prepared, signature });
  const data: EncodedShareData = {
    version: 1, host: stale, spaceId, path, keyDid,
    key: JSON.parse(manager.jwk(keyId)!),
    delegation: {
      cid: parent.delegationCid, authHeader: parent.delegationHeader.Authorization,
      delegateDID: keyDid, delegatorDID: pkhDid(owner.address, 1), spaceId, path,
      actions: ["tinycloud.kv/get"], expiry, isRevoked: false, allowSubDelegation: true,
    },
  };
  const subject = pkhDid(owner.address, 1);
  const record = await signLocationRecordV2({
    version: 2, subject, nodes: [{ did: NODE_DID, url: routed }],
    spaces: [{ space: spaceId.toLowerCase(), nodes: [{ did: NODE_DID, mode: "read-write" }] }],
    encryptionNode: NODE_DID, updated_at: new Date().toISOString(), sequence: 1,
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage(message) });
  if (options.warm) {
    const ownerKey = registryOwnerKeyV2(subject);
    await createLocalStorageRegistryCacheStore(storage).update(ownerKey, () => ({
      ownerKey, responseBody: JSON.stringify({ record }), fetchedAt: Date.now(), sequence: 1,
    }));
  }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://registry.tinycloud.xyz") {
      remember(request);
      if (options.registered) {
        expect(request.method).toBe("GET");
        expect(request.headers.has("authorization")).toBe(false);
        expect(url.pathname).toBe(`/v2/locations/${encodeURIComponent(registryOwnerKeyV2(subject))}`);
        return Response.json({ record });
      }
      return new Response("registry unavailable", { status: 503 });
    }
    if (![stale, routed, sink].includes(url.origin)) throw new Error("Unexpected non-loopback fixture request");
    return nativeFetch(request);
  }) as typeof fetch;
  const restoreData = {
    delegationHeader: parent.delegationHeader, delegationCid: parent.delegationCid,
    spaceId, jwk: data.key, verificationMethod: keyDid, address: owner.address,
    chainId: 1, siwe: prepared.siwe, signature,
  };
  return { data, attempts, stale, routed, sink, wasm, restoreData, link: () => encode(data) };
}

describe("TinyCloudWeb static receiveShare verified routing", () => {
  test("cold registry refuses before sending any share credential", async () => {
    const f = await fixture();
    const result = await TinyCloudWeb.receiveShare(f.link());
    expect(result.ok).toBe(false);
    expect(f.attempts.filter((attempt) => attempt.authorization !== null || attempt.method === "POST")).toEqual([]);
    expect(f.attempts.every((attempt) => attempt.origin === "https://registry.tinycloud.xyz")).toBe(true);
  });

  test("warm cached verified parent activates once at the checked destination and reads with the share actor", async () => {
    const f = await fixture({ warm: true });
    const result = await TinyCloudWeb.receiveShare<{ message: string }>(f.link());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.data).toEqual({ message: "verified shared data" });
    expect(result.data.delegation.cid).toBe(f.data.delegation.cid);
    expect(result.data.delegation.authHeader).toBe(f.data.delegation.authHeader);
    expect(result.data.path).toBe(f.data.path);
    expect(result.data.spaceId).toBe(f.data.spaceId);
    expect(result.data.host).toBe(f.routed);
    expect(f.attempts.some((attempt) => attempt.origin === f.stale || attempt.origin === f.sink)).toBe(false);
    const activations = f.attempts.filter((attempt) => attempt.path === "/delegate");
    expect(activations).toHaveLength(1);
    expect(activations[0]!.origin).toBe(f.routed);
    expect(activations[0]!.authorization).toBe(f.data.delegation.authHeader);
    const firstCredential = f.attempts.findIndex((attempt) => attempt.authorization !== null);
    for (const path of ["/info", "/.well-known/tinycloud/node-keys"]) {
      expect(f.attempts.slice(0, firstCredential).some((attempt) => attempt.origin === f.routed && attempt.path === path)).toBe(true);
    }
    const invocation = f.attempts.find((attempt) => attempt.path === "/invoke")!;
    const verified = verifyNativeInvocation(invocation.authorization!);
    expect(verified.payload.iss.split("#")[0]).toBe(f.data.keyDid.split("#")[0]);
    expect(verified.payload.aud).toBe(NODE_DID);
    expect(verified.payload.prf).toEqual([f.data.delegation.cid]);
    expect(Object.keys(verified.payload.att)).toEqual([`${f.data.spaceId}/kv/${f.data.path}`]);
  });

  test("fresh signed registry lookup routes the verified parent and share read without seeded cache", async () => {
    const f = await fixture({ registered: true });
    const result = await TinyCloudWeb.receiveShare<{ message: string }>(f.link());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.data).toEqual({ message: "verified shared data" });
    expect(result.data.host).toBe(f.routed);
    expect(result.data.delegation.authHeader).toBe(f.data.delegation.authHeader);
    const firstCredential = f.attempts.findIndex((attempt) => attempt.authorization !== null);
    const registryLookup = f.attempts.findIndex((attempt) => attempt.origin === "https://registry.tinycloud.xyz");
    expect(registryLookup).toBeGreaterThanOrEqual(0);
    expect(registryLookup).toBeLessThan(firstCredential);
    for (const path of ["/info", "/.well-known/tinycloud/node-keys"]) {
      expect(f.attempts.slice(0, firstCredential).some((attempt) => attempt.origin === f.routed && attempt.path === path)).toBe(true);
    }
    expect(f.attempts.filter((attempt) => attempt.authorization !== null).map((attempt) => `${attempt.origin}${attempt.path}`))
      .toEqual([`${f.routed}/delegate`, `${f.routed}/invoke`]);
    expect(f.attempts.some((attempt) => attempt.origin === f.stale || attempt.origin === f.sink)).toBe(false);
    const invocation = f.attempts.find((attempt) => attempt.path === "/invoke")!;
    const verified = verifyNativeInvocation(invocation.authorization!);
    expect(verified.payload.iss.split("#")[0]).toBe(f.data.keyDid.split("#")[0]);
    expect(verified.payload.aud).toBe(NODE_DID);
    expect(verified.payload.prf).toEqual([f.data.delegation.cid]);
    expect(Object.keys(verified.payload.att)).toEqual([`${f.data.spaceId}/kv/${f.data.path}`]);
  });

  for (const tamper of ["parent", "CID", "private key", "key DID", "space", "missing parent"] as const) {
    test(`tampered ${tamper} refuses without any POST`, async () => {
      const f = await fixture({ warm: true });
      if (tamper === "parent") {
        await expect(parseSignedSiweCacao(f.data.delegation.authHeader!, f.data.delegation.cid))
          .resolves.toMatchObject({ cid: f.data.delegation.cid });
        const bytes = Buffer.from(f.data.delegation.authHeader!, "base64url");
        // Same real-CACAO corruption pattern as sdk-core cacao.test.ts:
        // the final signature bytes precede the nine-byte `"t": "eip191"` suffix.
        bytes[bytes.length - 12]! ^= 0x01;
        f.data.delegation.authHeader = bytes.toString("base64url");
        f.data.delegation.cid = f.wasm.computeCid(bytes, 0x55n);
        await expect(parseSignedSiweCacao(f.data.delegation.authHeader, f.data.delegation.cid))
          .rejects.toThrow("signature is invalid");
      }
      if (tamper === "CID") f.data.delegation.cid = "bafy-invalid-parent";
      if (tamper === "private key") f.data.key.d = Buffer.from(new Uint8Array(32).fill(77)).toString("base64url");
      if (tamper === "key DID") f.data.keyDid = NODE_DID;
      if (tamper === "space") f.data.spaceId = f.data.spaceId.replace(":applications", ":different");
      if (tamper === "missing parent") delete f.data.delegation.authHeader;
      const result = await TinyCloudWeb.receiveShare(f.link());
      expect(result.ok).toBe(false);
      expect(f.attempts.filter((attempt) => attempt.method === "POST")).toEqual([]);
    });
  }

  test("forged unverified JSON refuses before any credential-bearing POST", async () => {
    const f = await fixture({ warm: true });
    f.data.key = { kty: "OKP", crv: "Ed25519", x: "invalid", d: "invalid" };
    f.data.keyDid = "did:key:unverified";
    f.data.delegation.cid = "unverified-cid";
    f.data.delegation.authHeader = "synthetic-unverified-bearer";
    expect((await TinyCloudWeb.receiveShare(f.link())).ok).toBe(false);
    expect(f.attempts.filter((attempt) => attempt.method === "POST")).toEqual([]);
  });

  test("a warm destination with the wrong identity refuses before credentials", async () => {
    const f = await fixture({ warm: true, wrongIdentity: true });
    expect((await TinyCloudWeb.receiveShare(f.link())).ok).toBe(false);
    expect(f.attempts.filter((attempt) => attempt.authorization !== null || attempt.method === "POST")).toEqual([]);
  });

  for (const redirect of ["/delegate", "/invoke"] as const) {
    test(`native 307 at ${redirect} refuses without forwarding the share credential`, async () => {
      const f = await fixture({ warm: true, redirect });
      // Make the untrusted recorded host the checked host too, so the old raw path
      // really reaches the 307 rather than failing at a stale-host fixture response.
      f.data.host = f.routed;
      const result = await TinyCloudWeb.receiveShare(f.link());
      expect(result.ok).toBe(false);
      expect(f.attempts.filter((attempt) => attempt.origin === f.sink)).toEqual([]);
      expect(f.attempts.some((attempt) => attempt.origin === f.routed && attempt.path === redirect)).toBe(true);
    });
  }
});

/** Native WASM UCANs sign the original JSON bytes, not the envelope canonical-JSON profile. */
function verifyNativeInvocation(token: string) {
  const [header, body, signature] = token.split(".");
  const payload = JSON.parse(Buffer.from(body!, "base64url").toString()) as {
    iss: string; aud: string; prf: string[]; att: Record<string, unknown>;
  };
  const bytes = base58btc.decode(payload.iss.split("#", 1)[0]!.slice("did:key:".length));
  expect([bytes[0], bytes[1]]).toEqual([0xed, 0x01]);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(bytes.slice(2)).toString("base64url") },
    format: "jwk",
  });
  expect(verify(null, Buffer.from(`${header}.${body}`), key, Buffer.from(signature!, "base64url"))).toBe(true);
  return { payload };
}

function wrapperFor(node: TinyCloudNode) {
  const web = Object.create(TinyCloudWeb.prototype) as TinyCloudWeb;
  Object.assign(web, { _node: node, signOutCount: 0, signOutInFlight: 0 });
  return web;
}

describe("TinyCloudWeb entry-bound wrapper authority", () => {
  test("unchanged authority dispatches an actual browser-WASM revoke", async () => {
    const f = await fixture({ warm: true, wrapper: true });
    const node = new TinyCloudNode({
      wasmBindings: f.wasm,
      registrySequenceStore: createLocalStorageRegistrySequenceStore(),
      registryCacheStore: createLocalStorageRegistryCacheStore(),
      newUserHost: null,
    });
    await node.restoreSession(f.restoreData);
    const web = wrapperFor(node);
    await web.revokeDelegation(f.data.delegation.cid);
    const posts = f.attempts.filter((attempt) => attempt.method === "POST");
    expect(posts.map((attempt) => `${attempt.origin}${attempt.path}`)).toEqual([`${f.routed}/revoke`]);
    const verified = verifyNativeInvocation(posts[0]!.authorization!);
    expect(verified.payload.iss.split("#")[0]).toBe(node.restorableSession!.verificationMethod.split("#")[0]);
    expect(verified.payload.prf).toEqual([node.restorableSession!.delegationCid]);
  });

  for (const operation of ["revokeDelegation", "activeNodeIdentity"] as const) {
    for (const replacement of ["node", "signed session"] as const) {
      test(`${operation} refuses ${replacement} replacement during gated ensureNode without dispatching B`, async () => {
        const f = await fixture({ warm: true, wrapper: true });
        const nodeConfig = {
          wasmBindings: f.wasm,
          registrySequenceStore: createLocalStorageRegistrySequenceStore(),
          registryCacheStore: createLocalStorageRegistryCacheStore(),
          newUserHost: null,
        };
        const nodeA = new TinyCloudNode(nodeConfig);
        const nodeB = new TinyCloudNode(nodeConfig);
        await nodeA.restoreSession(f.restoreData);
        // A separately generated browser key and signed parent make B real authority,
        // not a method stub. Both grants belong to the same synthetic owner.
        const manager = f.wasm.createSessionManager();
        const id = manager.createSessionKey("wrapper-replacement");
        const did = manager.getDID(id);
        const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
        const prepared = f.wasm.prepareSession({
          abilities: { delegation: { "": ["tinycloud.delegation/revoke"] } },
          address: owner.address, chainId: 1, domain: "wrapper-replacement.test",
          issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 60 * 60_000).toISOString(),
          spaceId: f.data.spaceId, delegateUri: did,
        });
        const signature = await owner.signMessage(prepared.siwe);
        const signed = f.wasm.completeSessionSetup({ ...prepared, signature });
        const replacementData = {
          delegationHeader: signed.delegationHeader, delegationCid: signed.delegationCid,
          spaceId: f.data.spaceId, jwk: JSON.parse(manager.jwk(id)!), verificationMethod: did,
          address: owner.address, chainId: 1, siwe: prepared.siwe, signature,
        };
        await nodeB.restoreSession(replacementData);
        // Prove B's real signed operation reaches the owned node before the race.
        await nodeB.revokeDelegation(f.data.delegation.cid);
        expect(f.attempts.some((attempt) => attempt.origin === f.routed && attempt.path === "/revoke" && attempt.authorization !== null)).toBe(true);
        f.attempts.length = 0;
        const web = wrapperFor(nodeA);
        const opened = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        Reflect.set(web, "ensureNode", async () => {
          opened.resolve();
          await release.promise;
          return Reflect.get(web, "_node") as TinyCloudNode;
        });
        const pending = (operation === "revokeDelegation"
          ? web.revokeDelegation(f.data.delegation.cid)
          : web.activeNodeIdentity()).then(() => undefined, (error: unknown) => error);
        await opened.promise;
        if (replacement === "node") Reflect.set(web, "_node", nodeB);
        else await nodeA.restoreSession(replacementData);
        f.attempts.length = 0;
        release.resolve();
        const error = await pending;
        expect(f.attempts.filter((attempt) => attempt.authorization !== null || attempt.method === "POST")).toEqual([]);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/changed|cancel|replac/i);
      });
    }
  }
});

test("ensureSpaceHosted refuses signed-session replacement during wallet address lookup before hosting", async () => {
  const f = await fixture({ warm: true, wrapper: true });
  const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const node = new TinyCloudNode({
    wasmBindings: f.wasm,
    signer: {
      signMessage: (message) => owner.signMessage(typeof message === "string" ? message : Uint8Array.from(message)),
      getAddress: async () => owner.address,
      getChainId: async () => 1,
    },
    registrySequenceStore: createLocalStorageRegistrySequenceStore(),
    registryCacheStore: createLocalStorageRegistryCacheStore(),
    newUserHost: null,
  });
  await node.restoreSession(f.restoreData);
  const web = wrapperFor(node);
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hostingCalls = 0;
  Object.assign(web, {
    config: { autoCreateSpace: true },
    walletSigner: { getAddress: async () => { opened.resolve(); await release.promise; return owner.address; } },
  });
  // Concrete hosting seam: the race must refuse before entering Node's hosting
  // method, independently of whether a server happens to consider it hosted.
  Object.defineProperty(node, "spaceHosting", { configurable: true, get: () => "not-hosted" });
  Reflect.set(node, "ensurePrimarySpaceHosted", async () => { hostingCalls++; });
  const pending = web.ensureSpaceHosted().then(() => undefined, (error: unknown) => error);
  await opened.promise;
  await node.restoreSession(f.restoreData);
  f.attempts.length = 0;
  release.resolve();
  const error = await pending;
  expect(hostingCalls).toBe(0);
  expect(f.attempts.filter((attempt) => attempt.authorization !== null || attempt.method === "POST")).toEqual([]);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/changed|cancel|replac/i);
});
