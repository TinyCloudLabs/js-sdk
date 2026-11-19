import "./support/browserGlobalsShim";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Wallet } from "ethers";
import {
  pkhDid,
  REGISTRY_NOT_FOUND_BODY,
  registryOwnerKeyV2,
  signLocationRecordV2,
  type EncodedShareData,
} from "@tinycloud/sdk-core";
import { TinyCloudWeb } from "../src/modules/tcw";
import { BrowserWasmBindings } from "../src/adapters/BrowserWasmBindings";

// TC-3374: a link-only share from an owner the registry has never heard of opens through the host recorded in the
// link, as it did before 3.12; a registered owner keeps the registry's hosts; an unavailable registry still refuses.

const nativeFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const NODE_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";
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
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } },
  });
}

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server.url.origin;
}

type Registry = "unregistered" | "registered" | "unavailable";

async function fixture(registry: Registry, linkHostIs: "recorded-node" | "registry-node") {
  browserStorage();
  const attempts: Array<{ origin: string; path: string; method: string }> = [];
  const remember = (request: Request) => {
    const url = new URL(request.url);
    attempts.push({ origin: url.origin, path: url.pathname, method: request.method });
  };
  const node = (label: string) => serve((request) => {
    remember(request);
    const path = new URL(request.url).pathname;
    if (path === "/info") return Response.json({ nodeId: NODE_DID });
    if (path === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: NODE_DID });
    if (path === "/delegate") return Response.json({ activated: ["parent"] });
    if (path === "/invoke") return Response.json({ message: `shared data from ${label}` });
    return new Response("unexpected fixture endpoint", { status: 404 });
  });
  // `recorded` is the host the sender wrote into the link; `registered` is where the registry's signed record sends the owner.
  const recorded = node("recorded");
  const registered = node("registered");

  const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const wasm = new BrowserWasmBindings();
  await wasm.ensureInitialized();
  const manager = wasm.createSessionManager();
  const keyId = manager.createSessionKey("static-receive-unregistered");
  const keyDid = manager.getDID(keyId);
  const spaceId = `tinycloud:pkh:eip155:1:${owner.address}:applications`;
  const path = "shared/report.json";
  const expiry = new Date(Date.now() + 60 * 60_000);
  const prepared = wasm.prepareSession({
    abilities: { kv: { [path]: ["tinycloud.kv/get"] } },
    address: owner.address, chainId: 1, domain: "static-receive.test",
    issuedAt: new Date().toISOString(), expirationTime: expiry.toISOString(), spaceId, delegateUri: keyDid,
  });
  const signature = await owner.signMessage(prepared.siwe);
  const parent = wasm.completeSessionSetup({ ...prepared, signature });
  const data: EncodedShareData = {
    version: 1, host: linkHostIs === "recorded-node" ? recorded : registered, spaceId, path, keyDid,
    key: JSON.parse(manager.jwk(keyId)!),
    delegation: {
      cid: parent.delegationCid, authHeader: parent.delegationHeader.Authorization,
      delegateDID: keyDid, delegatorDID: pkhDid(owner.address, 1), spaceId, path,
      actions: ["tinycloud.kv/get"], expiry, isRevoked: false, allowSubDelegation: true,
    },
  };
  const subject = pkhDid(owner.address, 1);
  const record = await signLocationRecordV2({
    version: 2, subject, nodes: [{ did: NODE_DID, url: registered }],
    spaces: [{ space: spaceId.toLowerCase(), nodes: [{ did: NODE_DID, mode: "read-write" }] }],
    encryptionNode: NODE_DID, updated_at: new Date().toISOString(), sequence: 1,
  }, { type: "did:pkh", signMessage: (message) => owner.signMessage(message) });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://registry.tinycloud.xyz") {
      remember(request);
      if (registry === "registered") {
        expect(url.pathname).toBe(`/v2/locations/${encodeURIComponent(registryOwnerKeyV2(subject))}`);
        return Response.json({ record });
      }
      return registry === "unregistered" ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }) : new Response("registry unavailable", { status: 503 });
    }
    if (![recorded, registered].includes(url.origin)) throw new Error(`Unexpected non-loopback fixture request to ${url.origin}`);
    return nativeFetch(request);
  }) as typeof fetch;
  const encode = (value: EncodedShareData) => `tc1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  return { data, attempts, recorded, registered, link: encode(data), encode };
}

const nodeTraffic = (f: { attempts: Array<{ origin: string }> }, origin: string) => f.attempts.filter((attempt) => attempt.origin === origin);

describe("TinyCloudWeb static receiveShare for an owner the registry does not know (TC-3374)", () => {
  test("opens through the host recorded in the link and sends nothing anywhere else", async () => {
    const f = await fixture("unregistered", "recorded-node");
    const result = await TinyCloudWeb.receiveShare<{ message: string }>(f.link);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.data).toEqual({ message: "shared data from recorded" });
    expect(result.data.host).toBe(f.recorded);
    expect(nodeTraffic(f, f.recorded).some((attempt) => attempt.path === "/delegate")).toBe(true);
    expect(nodeTraffic(f, f.registered)).toEqual([]);
    // The registry was asked first (v2, then the v1 fallback), and no other origin was involved.
    expect(f.attempts.filter((attempt) => attempt.origin === "https://registry.tinycloud.xyz").length).toBeGreaterThan(0);
    expect(f.attempts[0]!.origin).toBe("https://registry.tinycloud.xyz");
  });

  test("a registered owner is routed by the registry and the link's host gets no traffic", async () => {
    const f = await fixture("registered", "recorded-node");
    const result = await TinyCloudWeb.receiveShare<{ message: string }>(f.link);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.data).toEqual({ message: "shared data from registered" });
    expect(result.data.host).toBe(f.registered);
    expect(nodeTraffic(f, f.recorded)).toEqual([]);
  });

  test("an unavailable registry still refuses and the link's host is never contacted", async () => {
    const f = await fixture("unavailable", "recorded-node");
    const result = await TinyCloudWeb.receiveShare(f.link);
    expect(result.ok).toBe(false);
    expect(nodeTraffic(f, f.recorded)).toEqual([]);
    expect(nodeTraffic(f, f.registered)).toEqual([]);
  });

  test("a link host that is neither HTTPS nor loopback is refused for an unregistered owner", async () => {
    const f = await fixture("unregistered", "recorded-node");
    const result = await TinyCloudWeb.receiveShare(f.encode({ ...f.data, host: "http://203.0.113.9" }));
    expect(result.ok).toBe(false);
    expect(nodeTraffic(f, f.recorded)).toEqual([]);
  });
});
