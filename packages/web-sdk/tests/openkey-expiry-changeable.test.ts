import "./support/browserGlobalsShim";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";

// TC-2276: `openkey.expiryChangeable` is a pass-through. A popup-shaped approval that returns a message with a
// different Expiration Time builds a session carrying the SIGNED expiry, and only when the app opted in.
// Real TinyCloudWeb (dist), TinyCloudNode and bridge; only the wallet and the OpenKey approval are simulated.

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const signer = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  get length() { return this.items.size; }
  clear() { this.items.clear(); }
  getItem(key: string) { return this.items.get(key) ?? null; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string) { this.items.delete(key); }
  setItem(key: string, value: string) { this.items.set(key, value); }
  values() { return [...this.items.values()]; }
}

let priorWindow: typeof globalThis.window | undefined;
let priorStorage: PropertyDescriptor | undefined;
let storage: MemoryStorage;
let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  priorWindow = globalThis.window;
  globalThis.window = {
    location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    open: () => ({}),
  } as unknown as Window & typeof globalThis;
  priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage, writable: true });
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.endsWith("/info")) {
      return new Response(JSON.stringify({ protocol: 1, version: "1.0.0", features: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/delegate") && init?.method === "POST") {
      return new Response(JSON.stringify({ activated: ["space"], skipped: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else globalThis.window = priorWindow;
  if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

type Request = { siwe: string; expiryChangeable?: boolean };

/** The result OpenKey returns after the user changed the expiry: the same message with a new Expiration Time, signed. */
async function approvalWithExpiry(request: Request, expiry: string) {
  const signedMessage = request.siwe.replace(/^Expiration Time: .*$/m, `Expiration Time: ${expiry}`);
  const selectedActionKeys: string[] = [];
  const permissions: Array<{ service: string; space: string; path: string; actions: string[] }> = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(signedMessage))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const grouped = new Map<string, string[]>();
    for (const ability of Object.keys(actions)) {
      const service = ability.split("/")[0]!;
      if (ability !== "tinycloud.capabilities/read" && ability !== "capabilities/read") {
        selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      }
      grouped.set(service, [...(grouped.get(service) ?? []), ability]);
    }
    for (const [service, abilities] of grouped) permissions.push({ service, space, path, actions: abilities });
  }
  return {
    protocolVersion: 1 as const,
    address,
    signature: await signer.signMessage({ message: signedMessage }),
    signedMessage,
    selectedActionKeys,
    permissions,
  };
}

function create(expiry: string, openkeyOptions: { expiryChangeable?: boolean }) {
  const requests: Request[] = [];
  const openkey = {
    authorizeTinyCloud(request: Request) {
      requests.push(request);
      return approvalWithExpiry(request, expiry);
    },
  };
  const provider = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
      if (method === "eth_chainId") return "0x1";
      throw new Error(`Unexpected wallet method: ${method}`);
    },
  };
  return {
    requests,
    create: () => require("../dist/index.cjs").TinyCloudWeb.create({
      provider,
      openkey: { client: openkey, ...openkeyOptions },
      tinycloudHosts: ["https://node.example.test"],
      autoDiscoverLocalNode: false,
      persistSession: true,
      autoCreateSpace: false,
      autoBootstrapAccount: false,
      ui: false,
    }),
  };
}

function storedExpiries(): string[] {
  return storage.values().flatMap((value) => {
    try {
      const parsed = JSON.parse(value) as { expiresAt?: unknown };
      return typeof parsed.expiresAt === "string" ? [parsed.expiresAt] : [];
    } catch {
      return [];
    }
  });
}

for (const prepare of [false, true]) {
  test(`opt-in ${prepare ? "after prepareSignIn" : "without preparation"}: the request carries the flag and the session keeps the SIGNED expiry`, async () => {
    const signedExpiry = new Date(Date.now() + 10 * DAY_MS).toISOString();
    const setup = create(signedExpiry, { expiryChangeable: true });
    const web = await setup.create();
    if (prepare) await web.prepareSignIn();
    const session = await web.signIn();

    expect(setup.requests).toHaveLength(1);
    expect(setup.requests[0]!.expiryChangeable).toBe(true);
    expect(/Expiration Time: (.+)/.exec(session.siwe)?.[1]).toBe(signedExpiry);
    // The stored session carries the signed expiry too, so a reload does not restore a different lifetime.
    expect(storedExpiries()).toContain(signedExpiry);
  });
}

test("an earlier signed expiry is the stored expiry", async () => {
  const signedExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const setup = create(signedExpiry, { expiryChangeable: true });
  const web = await setup.create();
  const session = await web.signIn();
  expect(/Expiration Time: (.+)/.exec(session.siwe)?.[1]).toBe(signedExpiry);
  expect(storedExpiries()).toContain(signedExpiry);
});

test("without the opt-in no flag is sent and a changed expiry is refused", async () => {
  const setup = create(new Date(Date.now() + 10 * DAY_MS).toISOString(), {});
  const web = await setup.create();
  await expect(web.signIn()).rejects.toThrow("OpenKey signedMessage altered immutable SIWE fields: expirationTime");
  expect(Object.keys(setup.requests[0]!)).not.toContain("expiryChangeable");
  expect(storedExpiries()).toEqual([]);
});

test("a signed expiry more than 10 years away is refused with a message naming the limit", async () => {
  const setup = create(new Date(Date.now() + 11 * 365 * DAY_MS).toISOString(), { expiryChangeable: true });
  const web = await setup.create();
  await expect(web.signIn()).rejects.toThrow(
    "OpenKey signedMessage expiry is more than 10 years away, the longest this SDK accepts; choose a shorter expiry",
  );
  expect(storedExpiries()).toEqual([]);
});
