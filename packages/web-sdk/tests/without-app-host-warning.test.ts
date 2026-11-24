import "./support/browserGlobalsShim";
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { startUnregisteredLocationRegistry, type UnregisteredLocationRegistry } from "../../node-sdk/src/test-support/unregistered-location-registry";

// Outside a browser, a TinyCloudWeb with no `domain` and no manifest asks for the folder every such app shares
// (applications/xyz.tinycloud.app/), and its sign-in says so once per process. Real TinyCloudWeb (dist) and
// TinyCloudNode with a simulated wallet. The account is not registered, so each sign-in then stops at account setup.

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const WARNED = Symbol.for("tinycloud.warnedWithoutAppHost");
const SHARED_FOLDER_LINE =
  "TinyCloud: this app has no domain, so it shares the folder applications/xyz.tinycloud.app/ with every other app that has none. " +
  'Set `domain` (for example `domain: "notes.example.com"`) or pass a manifest to give it a folder of its own.';

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
let warn: ReturnType<typeof spyOn>;
beforeAll(() => {
  registry = startUnregisteredLocationRegistry();
});
afterAll(() => {
  registry?.stop(true);
});
beforeEach(() => {
  delete (globalThis as { [WARNED]?: true })[WARNED];
  priorWindow = globalThis.window;
  delete (globalThis as { window?: unknown }).window;
  priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage(), writable: true });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${registry.url.origin}/`)) {
      return originalFetch(input as Parameters<typeof globalThis.fetch>[0], init);
    }
    if (url.endsWith("/info")) return Response.json({ protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/delegate") && init?.method === "POST") return Response.json({ activated: ["space"], skipped: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  globalThis.fetch = originalFetch;
  if (priorWindow !== undefined) globalThis.window = priorWindow;
  if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { [WARNED]?: true })[WARNED];
});

function create(extra: Record<string, unknown> = {}) {
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x1";
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  return require("../dist/index.cjs").TinyCloudWeb.create({
    provider,
    tinycloudHosts: ["https://node.example.test"],
    tinycloudRegistryUrl: registry.url.origin,
    autoDiscoverLocalNode: false,
    persistSession: false,
    autoCreateSpace: false,
    autoBootstrapAccount: false,
    ui: false,
    ...extra,
  });
}

type Web = { signIn(): Promise<unknown>; _node: { capabilityRequest?: { manifests: Array<{ app_id: string }> } } };

const sharedFolderLines = () => warn.mock.calls.filter(([message]: unknown[]) => String(message).startsWith("TinyCloud: this app has no domain"));
const appIds = (web: Web) => web._node.capabilityRequest?.manifests.map((manifest) => manifest.app_id);
const signIn = (web: Web) => expect(web.signIn()).rejects.toThrow("Unexpected wallet method: personal_sign");

test("without a window, a domain or a manifest, sign-in asks for the shared folder and says so once", async () => {
  const web: Web = await create();
  expect(appIds(web)).toEqual(["xyz.tinycloud.app"]);
  await signIn(web);
  await signIn(web);
  await signIn(await create());
  expect(sharedFolderLines()).toEqual([[SHARED_FOLDER_LINE]]);
});

test("a domain or a manifest keeps it quiet", async () => {
  const named: Web = await create({ domain: "notes.example.com:8443" });
  expect(appIds(named)).toEqual(["com.example.notes_8443"]);
  await signIn(named);
  await signIn(await create({ manifest: { app_id: "com.example.declared", name: "Declared" } }));
  expect(sharedFolderLines()).toEqual([]);
});
