import "./support/browserGlobalsShim";
import { afterEach, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { REGISTRY_NOT_FOUND_BODY, pkhDid, type EncodedShareData } from "@tinycloud/sdk-core";
import { TinyCloudWeb } from "../src/modules/tcw";
import { BrowserWasmBindings } from "../src/adapters/BrowserWasmBindings";

const nativeFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const REGISTRY = "https://registry.tinycloud.xyz";
const KNOWN_NODE = "https://node.tinycloud.xyz";
const NODE_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
  globalThis.fetch = nativeFetch;
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

/**
 * A share whose owner has no registry record. Every request is answered in
 * process: the registry says "no record", the known node answers as a node, and
 * any other origin is recorded and refused.
 */
async function fixture(linkHost: string, registry: "no record" | "unavailable" = "no record") {
  browserStorage();
  const attempts: Array<{ origin: string; path: string; method: string; authorization: string | null }> = [];
  const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const wasm = new BrowserWasmBindings();
  await wasm.ensureInitialized();
  const manager = wasm.createSessionManager();
  const keyId = manager.createSessionKey("static-receive-host-hint");
  const keyDid = manager.getDID(keyId);
  const spaceId = `tinycloud:pkh:eip155:1:${owner.address}:applications`;
  const path = "shared/report.json";
  const expiry = new Date(Date.now() + 60 * 60_000);
  const prepared = wasm.prepareSession({
    abilities: { kv: { [path]: ["tinycloud.kv/get"] } },
    address: owner.address, chainId: 1, domain: "static-receive-host-hint.test",
    issuedAt: new Date().toISOString(), expirationTime: expiry.toISOString(), spaceId, delegateUri: keyDid,
  });
  const parent = wasm.completeSessionSetup({ ...prepared, signature: await owner.signMessage(prepared.siwe) });
  const data: EncodedShareData = {
    version: 1, host: linkHost, spaceId, path, keyDid,
    key: JSON.parse(manager.jwk(keyId)!),
    delegation: {
      cid: parent.delegationCid, authHeader: parent.delegationHeader.Authorization,
      delegateDID: keyDid, delegatorDID: pkhDid(owner.address, 1), spaceId, path,
      actions: ["tinycloud.kv/get"], expiry, isRevoked: false, allowSubDelegation: true,
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    attempts.push({ origin: url.origin, path: url.pathname, method: request.method, authorization: request.headers.get("authorization") });
    if (url.origin === REGISTRY) {
      return registry === "no record"
        ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } })
        : new Response("registry unavailable", { status: 503 });
    }
    if (url.origin !== KNOWN_NODE) return new Response("not a node", { status: 403 });
    if (url.pathname === "/info") return Response.json({ nodeId: NODE_DID });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: NODE_DID });
    if (url.pathname === "/delegate") return Response.json({ activated: ["parent"] });
    if (url.pathname === "/invoke") return Response.json({ message: "shared data from the known node" });
    return new Response("unexpected fixture endpoint", { status: 404 });
  }) as typeof fetch;
  const link = `tc1:${Buffer.from(JSON.stringify(data)).toString("base64url")}`;
  return { attempts, link, data };
}

describe("TinyCloudWeb static receiveShare with a link host and no registry record", () => {
  test("the link's production host serves the share, signed by the share key only", async () => {
    const f = await fixture(KNOWN_NODE);
    const result = await TinyCloudWeb.receiveShare<{ message: string }>(f.link);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.data).toEqual({ message: "shared data from the known node" });
    expect(result.data.host).toBe(KNOWN_NODE);
    expect(f.attempts[0]?.origin).toBe(REGISTRY);
    const credentialed = f.attempts.filter((attempt) => attempt.authorization !== null);
    expect(credentialed.map((attempt) => `${attempt.origin}${attempt.path}`)).toEqual([`${KNOWN_NODE}/delegate`, `${KNOWN_NODE}/invoke`]);
    const invocation = credentialed.find((attempt) => attempt.path === "/invoke")!;
    const [, body] = invocation.authorization!.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString()) as { iss: string; prf: string[] };
    expect(payload.iss.split("#")[0]).toBe(f.data.keyDid.split("#")[0]);
    expect(payload.prf).toEqual([f.data.delegation.cid]);
  });

  for (const host of [
    "http://127.0.0.1:9",
    "https://evil.example",
    "https://node.tinycloud.xyz.evil.example",
    "https://tee.node.tinycloud.xyz@evil.example",
    "https://node.tinycloud.xyz/path",
    "http://node.tinycloud.xyz",
  ]) {
    test(`a link host of ${host} is refused and receives no request`, async () => {
      const f = await fixture(host);
      const result = await TinyCloudWeb.receiveShare(f.link);
      expect(result.ok).toBe(false);
      expect(f.attempts.filter((attempt) => attempt.origin !== REGISTRY)).toEqual([]);
    });
  }

  test("a registry outage does not route to the link's production host", async () => {
    const f = await fixture(KNOWN_NODE, "unavailable");
    const result = await TinyCloudWeb.receiveShare(f.link);
    expect(result.ok).toBe(false);
    expect(f.attempts.filter((attempt) => attempt.origin !== REGISTRY)).toEqual([]);
  });
});
