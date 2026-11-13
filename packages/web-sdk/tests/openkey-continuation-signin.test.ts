import "./support/browserGlobalsShim";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "../../node-sdk/src/test-support/unregistered-location-registry";

const owner = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const identity = { address: owner.address, chainId: 1, keyId: "selected", keyType: "MANAGED", requestId: "request" };
const manifest = { app_id: "xyz.tinycloud.tc2913", name: "Continuation app", defaults: false,
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.tc2913/", actions: ["get", "list"] }] };
let registry: UnregisteredLocationRegistry;
let oldWindow: typeof window | undefined;
let oldLocation: typeof location | undefined;
let oldFetch: typeof fetch;
let activations = 0;
beforeAll(() => { registry = startUnregisteredLocationRegistry(); });
afterAll(() => { registry.stop(true); });
beforeEach(() => {
  oldWindow = globalThis.window;
  oldLocation = globalThis.location;
  oldFetch = globalThis.fetch;
  activations = 0;
  globalThis.window = { location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener() {}, removeEventListener() {}, open: () => ({}) } as unknown as Window & typeof globalThis;
  globalThis.location = window.location;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${registry.url.origin}/`)) return oldFetch(input, init);
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") { activations++; return Response.json({ activated: ["space"], skipped: [] }); }
    throw new Error(`Unexpected fetch: ${url}`);
  };
});
afterEach(() => {
  if (oldWindow === undefined) delete (globalThis as any).window; else globalThis.window = oldWindow;
  if (oldLocation === undefined) delete (globalThis as any).location; else globalThis.location = oldLocation;
  globalThis.fetch = oldFetch;
});

async function signedResult(siwe: string) {
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const service = ability.split("/")[0]!;
      if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, actions] of grouped) permissions.push({ service, space, path, actions });
  }
  return { protocolVersion: 1, address: owner.address, signature: await owner.signMessage({ message: siwe }),
    signedMessage: siwe, selectedActionKeys, permissions };
}

async function setup(enabled: boolean) {
  const calls = { reserved: 0, cancelled: 0, continuation: 0, legacy: 0, accountRequests: 0 };
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_accounts") return enabled ? [] : [owner.address];
    if (method === "eth_requestAccounts") { calls.accountRequests++; throw new Error("Unexpected interactive connect"); }
    throw new Error(`Unexpected wallet method ${method}`);
  } };
  const client = {
    getContinuationProvider: () => provider,
    supportsTinyCloudSignIn: async () => enabled,
    authorizeTinyCloud: async (request: { siwe: string }) => { calls.legacy++; return signedResult(request.siwe); },
    beginTinyCloudSignIn(options: any) {
      calls.reserved++;
      expect(typeof options.verify).toBe("function");
      return { cancel: () => { calls.cancelled++; }, authorize: async (prepare: any) => {
        calls.continuation++;
        const request = await prepare(identity);
        expect(request.presentation.manifests[0].payload).toEqual(manifest);
        const result = await signedResult(request.siwe);
        expect(activations).toBe(0);
        expect(await options.verify({ result, identity, request: structuredClone(request), origin: "https://example.test" })).toBe(true);
        expect(activations).toBe(0);
        return result;
      } };
    },
  };
  const web = await require("../dist/index.cjs").TinyCloudWeb.create({
    openkey: { client }, manifest, tinycloudHosts: ["https://node.example.test"],
    tinycloudRegistryUrl: registry.url.origin, autoDiscoverLocalNode: false,
    persistSession: false, autoCreateSpace: false, autoBootstrapAccount: false, ui: false,
  });
  return { web, calls };
}

test("public signIn reserves in the click tick, verifies the original manifest, then activates without connect", async () => {
  const { web, calls } = await setup(true);
  const signing = web.signIn();
  expect(calls.reserved).toBe(1);
  const result = await signing;
  expect(result.address).toBe(owner.address);
  expect(calls.continuation).toBe(1);
  expect(calls.accountRequests).toBe(0);
  expect(calls.legacy).toBe(0);
  expect(calls.cancelled).toBe(1);
  expect(activations).toBeGreaterThan(0);
});

test("a server without the continuation advertisement uses the existing authorization path", async () => {
  const { web, calls } = await setup(false);
  await web.signIn();
  expect(calls.continuation).toBe(0);
  expect(calls.cancelled).toBe(1);
  expect(calls.legacy).toBe(1);
});
