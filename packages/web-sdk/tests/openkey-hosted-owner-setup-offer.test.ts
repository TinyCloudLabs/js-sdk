import "./support/browserGlobalsShim";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startBrowserLocationRegistry, type BrowserLocationRegistry } from "../../node-sdk/src/test-support/browser-location-registry";

// TC-4344: an owner with no registry record whose own space the default node hosts signs in (the hosted-owner proof),
// and is then offered OpenKey's account setup without being blocked: the `account.setup.pending` event, or a toast
// whose button opens setup. Registered owners and owners the proof refuses keep their paths and get no offer.
// Real TinyCloudWeb (dist), TinyCloudNode and registry lookups against a local registry; the OpenKey client and the
// nodes are simulated.

const NODE = "https://node.example.test";
const nodeDid = "did:key:z6MktLHQwkV2x8WKZhmyB8qEShgvcMHfJbNjb2k21pVJQvfB";
const DEFAULT_NODE = "https://node.tinycloud.xyz";
const defaultNodeDid = "did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi";
// Only the app's own `applications` space: an unregistered owner gets the hosted-owner proof on the default node.
const manifest = { app_id: "xyz.tinycloud.offer", name: "Offer app", defaults: false,
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.offer/", actions: ["get", "list"] }] };

/** The owner whose `applications` space the default node hosts; undefined hosts nothing. */
let hostedOwner: string | undefined;
let registry: BrowserLocationRegistry;
let oldWindow: typeof window | undefined;
let oldLocation: typeof location | undefined;
let oldFetch: typeof fetch;
let activeWeb: { signOut(): Promise<void> } | undefined;
let nextKey = 0x0ffe5;
beforeAll(() => { registry = startBrowserLocationRegistry(); });
afterAll(() => { registry.stop(true); });
beforeEach(() => {
  oldWindow = globalThis.window;
  oldLocation = globalThis.location;
  oldFetch = globalThis.fetch;
  globalThis.window = { location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener() {}, removeEventListener() {}, open: () => ({}) } as unknown as Window & typeof globalThis;
  globalThis.location = window.location;
  hostedOwner = undefined;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${registry.url.origin}/`)) return oldFetch(input, init);
    if (url.startsWith(`${DEFAULT_NODE}/`)) {
      const path = new URL(url).pathname;
      if (path === "/info") return Response.json({ nodeId: defaultNodeDid, protocol: 1, version: "1.0.0", features: [] });
      if (path === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: defaultNodeDid });
      if (path === "/delegate" && init?.method === "POST") {
        return Response.json({ activated: hostedOwner ? [`tinycloud:pkh:eip155:1:${hostedOwner}:applications`] : [], skipped: [] });
      }
      // The proof's signed read: a 2xx only when the owner's space is hosted here.
      if (path === "/invoke") return hostedOwner ? Response.json({}) : new Response("not found", { status: 404 });
      return Response.json({});
    }
    if (!url.startsWith(`${NODE}/`)) throw new Error(`Unexpected fetch: ${url}`);
    if (url.endsWith("/info")) return Response.json({ nodeId: nodeDid, protocol: 1, version: "1.0.0", features: [] });
    if (url.endsWith("/.well-known/tinycloud/node-keys")) return Response.json({ nodeDid });
    if (url.endsWith("/delegate") && init?.method === "POST") return Response.json({ activated: ["space"], skipped: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  };
});
afterEach(async () => {
  await activeWeb?.signOut();
  activeWeb = undefined;
  if (oldWindow === undefined) delete (globalThis as { window?: unknown }).window; else globalThis.window = oldWindow;
  if (oldLocation === undefined) delete (globalThis as { location?: unknown }).location; else globalThis.location = oldLocation;
  globalThis.fetch = oldFetch;
});

async function signedResult(owner: PrivateKeyAccount, siwe: string) {
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

type Offer = { address: string; finishSetup(): Promise<boolean> };
type ToastRequest = { kind: string; textCode: string; action?: { labelCode: string; run(): void } };

async function setup(owner: "hosted" | "registered" | "refused", options: { keyType?: "MANAGED" | "EXTERNAL" } = {}) {
  const ownerKey = `0x${(nextKey++).toString(16).padStart(64, "0")}` as const;
  const account = privateKeyToAccount(ownerKey);
  if (owner === "hosted") hostedOwner = account.address;
  if (owner === "registered") await registry.register(ownerKey, NODE, nodeDid);
  const calls = { setup: [] as Array<{ keyId: string }>, approvals: 0 };
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_accounts") return [account.address];
    throw new Error(`Unexpected wallet method ${method}`);
  } };
  const client = {
    lastAuth: { keyId: "key_7", address: account.address, keyType: options.keyType ?? "MANAGED" },
    getContinuationProvider: () => provider,
    authorizeTinyCloud: async (request: { siwe: string }) => {
      calls.approvals++;
      return signedResult(account, request.siwe);
    },
    setupAccount: async (opts: { keyId: string }) => {
      calls.setup.push(opts);
      await registry.register(ownerKey, NODE, nodeDid);
      return { outcome: "published" as const };
    },
  };
  const web = await require("../dist/index.cjs").TinyCloudWeb.create({
    openkey: { client }, manifest, tinycloudHosts: [NODE], tinycloudRegistryUrl: registry.url.origin,
    autoDiscoverLocalNode: false, persistSession: false, autoCreateSpace: false, autoBootstrapAccount: false,
  });
  activeWeb = web;
  // The page's toast host, observed at the SDK's one toast entry.
  const toasts: ToastRequest[] = [];
  (web as { uiClient: { toast(request: ToastRequest): boolean } }).uiClient.toast = (request) => { toasts.push(request); return true; };
  const offers: Offer[] = [];
  return { web, calls, account, toasts, offers, listen: () => web.on("account.setup.pending", (event: Offer) => offers.push(event)) };
}

test("a hosted owner with no record signs in, then a toast offers setup and its button sets up the signing key", async () => {
  const { web, calls, account, toasts } = await setup("hosted");
  expect((await web.signIn()).address).toBe(account.address);
  // Signed in with the one approval; nothing was opened.
  expect(calls.approvals).toBe(1);
  expect(calls.setup).toEqual([]);
  const offer = toasts.filter((toast) => toast.textCode === "toast.account_setup_pending");
  expect(offer).toHaveLength(1);
  expect(offer[0]!.action?.labelCode).toBe("toast.account_setup_action");
  // The button calls setup in the click's own tick, so OpenKey's window is not popup-blocked.
  offer[0]!.action!.run();
  expect(calls.setup).toEqual([{ keyId: "key_7" }]);
  // Setup asks for no further sign-in; the session goes on.
  expect(calls.approvals).toBe(1);
  expect(web.did.toLowerCase()).toBe(`did:pkh:eip155:1:${account.address.toLowerCase()}`);
});

test("an app with its own UI gets the event instead of the toast, and finishSetup sets up the signing key", async () => {
  const { web, calls, account, toasts, offers, listen } = await setup("hosted");
  listen();
  await web.signIn();
  expect(toasts.some((toast) => toast.textCode === "toast.account_setup_pending")).toBe(false);
  expect(offers.map((offer) => offer.address)).toEqual([account.address]);
  expect(await offers[0]!.finishSetup()).toBe(true);
  expect(calls.setup).toEqual([{ keyId: "key_7" }]);
});

test("finishSetup after sign-out opens nothing", async () => {
  const { web, calls, offers, listen } = await setup("hosted");
  listen();
  await web.signIn();
  await web.signOut();
  expect(await offers[0]!.finishSetup()).toBe(false);
  expect(calls.setup).toEqual([]);
});

test("a hosted owner signing in with a wallet key is not offered OpenKey's setup", async () => {
  const { web, toasts, offers, listen } = await setup("hosted", { keyType: "EXTERNAL" });
  listen();
  await web.signIn();
  expect(offers).toEqual([]);
  expect(toasts.some((toast) => toast.textCode === "toast.account_setup_pending")).toBe(false);
});

test("a registered owner gets no offer", async () => {
  const { web, calls, offers, listen } = await setup("registered");
  listen();
  await web.signIn();
  expect(offers).toEqual([]);
  expect(calls.setup).toEqual([]);
  expect(calls.approvals).toBe(1);
});

test("an owner the proof refuses keeps the setup-then-sign-in path and gets no offer after it", async () => {
  const { web, calls, offers, listen } = await setup("refused");
  listen();
  await web.signIn();
  expect(calls.setup).toEqual([{ keyId: "key_7" }]);
  expect(calls.approvals).toBe(2);
  expect(offers).toEqual([]);
});
