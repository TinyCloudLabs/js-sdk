import "./support/browserGlobalsShim";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "../../node-sdk/src/test-support/unregistered-location-registry";

// TC-4082. The default TinyCloudWeb manifest with a 404 registry now qualifies for the hosted-owner proof, so sign-in
// reaches the wallet. When the post-consent read of the owner's primary space is not a 2xx, sign-in must still end
// in ACCOUNT_SETUP_REQUIRED, with no session stored and nothing sent to retire it. Real TinyCloudWeb (dist) and
// TinyCloudNode with a simulated wallet that signs for real.

const { PrivateKeySigner } = require("@tinycloud/node-sdk");
const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const DEFAULT_NODE = "https://node.tinycloud.xyz";

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
}

let priorWindow: typeof globalThis.window | undefined;
let priorStorage: PropertyDescriptor | undefined;
let originalFetch: typeof globalThis.fetch;
let registry: UnregisteredLocationRegistry;
let storage: MemoryStorage;
let requests: string[];
let signed: number;
let address: string;
beforeAll(() => {
  registry = startUnregisteredLocationRegistry();
});
afterAll(() => {
  registry?.stop(true);
});
beforeEach(() => {
  priorWindow = globalThis.window;
  delete (globalThis as { window?: unknown }).window;
  priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage, writable: true });
  requests = [];
  signed = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === registry.url.origin) return originalFetch(input as Parameters<typeof globalThis.fetch>[0], init);
    requests.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.origin === DEFAULT_NODE) {
      if (url.pathname === "/info") return Response.json({ protocol: 1, version: "1.26.22", features: [] });
      if (url.pathname === "/delegate") return Response.json({ activated: [`tinycloud:pkh:eip155:1:${address}:applications`], skipped: [] });
      if (url.pathname === "/invoke") return new Response("Space not found", { status: 404 });
    }
    throw new Error(`Unexpected fetch: ${url.origin}${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (priorWindow !== undefined) globalThis.window = priorWindow;
  if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

test("the default manifest, a 404 registry and a failed post-consent read end in ACCOUNT_SETUP_REQUIRED with no session", async () => {
  address = await signer.getAddress();
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        signed += 1;
        return signer.signMessage(Buffer.from(String(params?.[0]).slice(2), "hex").toString("utf8"));
      }
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  const web = await require("../dist/index.cjs").TinyCloudWeb.create({
    provider,
    tinycloudHosts: ["https://node.example.test"],
    tinycloudRegistryUrl: registry.url.origin,
    autoDiscoverLocalNode: false,
    autoCreateSpace: false,
    autoBootstrapAccount: false,
    ui: false,
  });

  await expect(web.signIn()).rejects.toMatchObject({ code: "ACCOUNT_SETUP_REQUIRED", setupUrl: "https://tinycloud.one/" });

  expect(signed).toBe(1);
  expect(requests.filter((request) => request === `POST ${DEFAULT_NODE}/delegate`)).toHaveLength(1);
  expect(requests.filter((request) => request === `POST ${DEFAULT_NODE}/invoke`)).toHaveLength(1);
  expect(requests.filter((request) => request.includes("node.example.test"))).toEqual([]);
  expect(requests.filter((request) => request.includes("/session/retire"))).toEqual([]);
  expect(web.session()).toBeUndefined();
  // Only the local "retired" marker remains: the signed session is recorded as discarded, never stored for reuse.
  const keys = [...Array(storage.length).keys()].map((index) => String(storage.key(index)));
  expect(keys.filter((key) => /session/i.test(key) && !key.startsWith("tinycloud:session:retired:"))).toEqual([]);
  expect(keys.filter((key) => key.startsWith("tinycloud:session:retired:"))).toHaveLength(1);
});
