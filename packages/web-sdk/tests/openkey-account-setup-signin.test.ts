import "./support/browserGlobalsShim";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { startBrowserLocationRegistry, type BrowserLocationRegistry } from "../../node-sdk/src/test-support/browser-location-registry";

// A third-party sign-in of an owner with no registry record: the registry refuses it before OpenKey is asked to approve
// anything (or, for an app that asks only for its own space, the default node's hosted-owner proof refuses it after the
// approval), and an OpenKey client with `setupAccount` sets the account up, then the sign-in runs again and finishes.
// Real TinyCloudWeb (dist), TinyCloudNode and registry lookups against a local registry; the OpenKey client and the
// nodes are simulated.

const NODE = "https://node.example.test";
const nodeDid = "did:key:z6MktLHQwkV2x8WKZhmyB8qEShgvcMHfJbNjb2k21pVJQvfB";
// The app also reads the owner's `default` space, so the hosted-owner proof (own `applications` space only) does not
// apply and the registry's refusal comes before approval.
const manifest = { app_id: "xyz.tinycloud.setup", name: "Setup app", defaults: false,
  permissions: [
    { service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.setup/", actions: ["get", "list"] },
    { service: "tinycloud.kv", space: "default", path: "notes/", actions: ["get"] },
  ] };
// Only the app's own `applications` space: an unregistered owner gets the hosted-owner proof on the default node.
const ownSpaceManifest = { app_id: "xyz.tinycloud.setup", name: "Setup app", defaults: false,
  permissions: [{ service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.setup/", actions: ["get", "list"] }] };
const DEFAULT_NODE = "https://node.tinycloud.xyz";
const defaultNodeDid = "did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi";
/** What the default node was asked, path only. It hosts no space, so every hosted-owner proof is refused. */
let defaultNodeCalls: string[] = [];
let registry: BrowserLocationRegistry;
let oldWindow: typeof window | undefined;
let oldLocation: typeof location | undefined;
let oldFetch: typeof fetch;
let activeWeb: { signOut(): Promise<void> } | undefined;
let nextKey = 0x5e7;
beforeAll(() => { registry = startBrowserLocationRegistry(); });
afterAll(() => { registry.stop(true); });
beforeEach(() => {
  oldWindow = globalThis.window;
  oldLocation = globalThis.location;
  oldFetch = globalThis.fetch;
  globalThis.window = { location: { host: "example.test", hostname: "example.test", origin: "https://example.test" },
    addEventListener() {}, removeEventListener() {}, open: () => ({}) } as unknown as Window & typeof globalThis;
  globalThis.location = window.location;
  defaultNodeCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${registry.url.origin}/`)) return oldFetch(input, init);
    if (url.startsWith(`${DEFAULT_NODE}/`)) {
      const path = new URL(url).pathname;
      defaultNodeCalls.push(path);
      if (path === "/info") return Response.json({ nodeId: defaultNodeDid, protocol: 1, version: "1.0.0", features: [] });
      if (path === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: defaultNodeDid });
      if (path === "/delegate" && init?.method === "POST") return Response.json({ activated: [], skipped: [] });
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

type Mode = "iframe" | "popup" | "redirect" | undefined;

async function setup(options: {
  keyType?: "MANAGED" | "EXTERNAL";
  /** What the owner does in OpenKey's setup page: set the account up (the default) or close it. */
  setupOutcome?: "published" | "cancelled";
  /** Answers of the first approvals; a missing entry approves. */
  approvals?: Array<"blocked">;
  mode?: "iframe" | "popup";
  /** The client reserves OpenKey's window in the click tick (`beginTinyCloudSignIn`). */
  continuation?: boolean;
  /** In the reserved window, a refused first prepare, then the owner's record appears and a second prepare runs. */
  prepareAgainAfterRefusal?: boolean;
  manifest?: typeof manifest | typeof ownSpaceManifest;
} = {}) {
  const ownerKey = `0x${(nextKey++).toString(16).padStart(64, "0")}` as const;
  const owner = privateKeyToAccount(ownerKey);
  const calls = { setup: [] as Array<{ keyId: string }>, approvals: [] as Mode[], registeredBeforeApproval: [] as boolean[],
    events: [] as string[] };
  let registered = false;
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_accounts") return [owner.address];
    throw new Error(`Unexpected wallet method ${method}`);
  } };
  const client = {
    lastAuth: { keyId: "key_1", address: owner.address, keyType: options.keyType ?? "MANAGED" },
    getContinuationProvider: () => provider,
    authorizeTinyCloud: async (request: { siwe: string }, opts?: { mode?: Mode }) => {
      calls.approvals.push(opts?.mode);
      calls.registeredBeforeApproval.push(registered);
      if (options.approvals?.[calls.approvals.length - 1] === "blocked") {
        throw { code: "POPUP_BLOCKED", message: "Popup was blocked. Please allow popups or use redirect mode." };
      }
      return signedResult(owner, request.siwe);
    },
    setupAccount: async (opts: { keyId: string }) => {
      calls.setup.push(opts);
      calls.events.push("setup");
      if (options.setupOutcome === "cancelled") throw { code: "USER_CANCELLED", message: "The owner closed account setup." };
      await registry.register(ownerKey, NODE, nodeDid);
      registered = true;
      return { outcome: "published" as const };
    },
    ...(options.continuation ? {
      supportsTinyCloudSignIn: async () => true,
      beginTinyCloudSignIn: () => ({
        cancel: () => { calls.events.push("cancel"); },
        authorize: async (prepare: (identity: Record<string, unknown>) => Promise<{ siwe: string }>) => {
          calls.events.push("continuation");
          const identity = { address: owner.address, chainId: 1, keyId: "key_1", keyType: options.keyType ?? "MANAGED", requestId: "request" };
          let request: { siwe: string };
          try {
            request = await prepare(identity);
          } catch (error) {
            if (!options.prepareAgainAfterRefusal) throw error;
            calls.events.push("prepare-refused");
            await registry.register(ownerKey, NODE, nodeDid);
            registered = true;
            request = await prepare(identity);
          }
          return signedResult(owner, request.siwe);
        },
      }),
    } : {}),
  };
  const web = await require("../dist/index.cjs").TinyCloudWeb.create({
    openkey: { client, ...(options.mode ? { mode: options.mode } : {}) }, manifest: options.manifest ?? manifest, tinycloudHosts: [NODE],
    tinycloudRegistryUrl: registry.url.origin, autoDiscoverLocalNode: false,
    persistSession: false, autoCreateSpace: false, autoBootstrapAccount: false, ui: false,
  });
  activeWeb = web;
  return { web, calls, owner };
}

test("the registry's refusal opens OpenKey's account setup for the signing key, then the sign-in finishes", async () => {
  const { web, calls, owner } = await setup();
  const session = await web.signIn();
  expect(session.address).toBe(owner.address);
  expect(calls.setup).toEqual([{ keyId: "key_1" }]);
  // OpenKey is asked to approve once, after setup, in the app's configured mode.
  expect(calls.approvals).toEqual(["popup"]);
  expect(calls.registeredBeforeApproval).toEqual([true]);
});

test("a refusal while OpenKey's window is reserved closes that window, then sets up and signs in", async () => {
  const { web, calls, owner } = await setup({ continuation: true });
  expect((await web.signIn()).address).toBe(owner.address);
  expect(calls.setup).toEqual([{ keyId: "key_1" }]);
  // The reserved window is cancelled before OpenKey's setup opens; the sign-in after setup asks for one approval.
  expect(calls.events.slice(0, 3)).toEqual(["continuation", "cancel", "setup"]);
  expect(calls.approvals).toEqual(["popup"]);
  expect(calls.registeredBeforeApproval).toEqual([true]);
});

test("a blocked approval popup after setup asks in OpenKey's frame", async () => {
  const { web, calls, owner } = await setup({ approvals: ["blocked"] });
  expect((await web.signIn()).address).toBe(owner.address);
  expect(calls.setup).toHaveLength(1);
  expect(calls.approvals).toEqual(["popup", "iframe"]);
});

test("an app in iframe mode is asked again in iframe mode, once", async () => {
  const { web, calls } = await setup({ mode: "iframe" });
  await web.signIn();
  expect(calls.approvals).toEqual(["iframe"]);
});

test("an owner who closes setup gets the AccountSetupRequiredError and no approval is asked", async () => {
  const { web, calls } = await setup({ setupOutcome: "cancelled" });
  await expect(web.signIn()).rejects.toMatchObject({ code: "ACCOUNT_SETUP_REQUIRED", setupUrl: "https://tinycloud.one/?finish-setup=registry" });
  expect(calls.setup).toHaveLength(1);
  expect(calls.approvals).toEqual([]);
});

test("a wallet key is not offered OpenKey's setup", async () => {
  const { web, calls } = await setup({ keyType: "EXTERNAL" });
  await expect(web.signIn()).rejects.toMatchObject({ code: "ACCOUNT_SETUP_REQUIRED", setupUrl: "https://tinycloud.one/?finish-setup=registry" });
  expect(calls.setup).toEqual([]);
  expect(calls.approvals).toEqual([]);
});

/** The SDK bundle's own AccountSetupRequiredError class, taken from a real registry refusal (a wallet key is not offered setup). */
async function bundleRefusalClass(): Promise<new () => Error> {
  const probe = await setup({ keyType: "EXTERNAL" });
  const Refusal = (await probe.web.signIn().catch((error: Error) => error)).constructor as new () => Error;
  await probe.web.signOut();
  return Refusal;
}

test("a refusal before OpenKey is asked to approve is offered setup once; another refusal after the approval is not", async () => {
  const Refusal = await bundleRefusalClass();
  for (const approvalAsked of [false, true]) {
    const { web, calls } = await setup();
    const refusal = new Refusal();
    const node = await web.ensureNode();
    node.signInWithOpenKey = async (authorize: (input: { siwe: string }) => Promise<unknown>) => {
      if (approvalAsked) await authorize({ siwe: "unused" }).catch(() => undefined);
      throw refusal;
    };
    // Before approval: setup runs, and the sign-in after it is refused again without a second setup.
    await expect(web.signIn()).rejects.toBe(refusal);
    expect(calls.setup).toHaveLength(approvalAsked ? 0 : 1);
  }
});

test("the hosted-owner proof's refusal after the approval opens setup, then the sign-in is approved once more", async () => {
  const { web, calls, owner } = await setup({ manifest: ownSpaceManifest });
  expect((await web.signIn()).address).toBe(owner.address);
  // The default node was asked to host the owner's own space and did not.
  expect(defaultNodeCalls).toContain("/delegate");
  expect(calls.setup).toEqual([{ keyId: "key_1" }]);
  expect(calls.approvals).toEqual(["popup", "popup"]);
  expect(calls.registeredBeforeApproval).toEqual([false, true]);
});

test("the hosted-owner proof's refusal in OpenKey's reserved window opens setup, then one more approval", async () => {
  const { web, calls, owner } = await setup({ manifest: ownSpaceManifest, continuation: true });
  expect((await web.signIn()).address).toBe(owner.address);
  expect(calls.events.slice(0, 3)).toEqual(["continuation", "cancel", "setup"]);
  expect(calls.approvals).toEqual(["popup"]);
  expect(calls.registeredBeforeApproval).toEqual([true]);
});

test("an owner who closes setup after the hosted-owner proof's refusal gets that refusal and no second approval", async () => {
  const { web, calls } = await setup({ manifest: ownSpaceManifest, setupOutcome: "cancelled" });
  await expect(web.signIn()).rejects.toMatchObject({ code: "ACCOUNT_SETUP_REQUIRED" });
  expect(calls.setup).toHaveLength(1);
  expect(calls.approvals).toEqual(["popup"]);
});

test("a refused prepare, then a prepare that succeeds, then a refusal after the approval: no setup", async () => {
  const Refusal = await bundleRefusalClass();
  const { web, calls } = await setup({ continuation: true, prepareAgainAfterRefusal: true });
  const refusal = new Refusal();
  const node = await web.ensureNode();
  node.signInWithPreparedOpenKey = async () => { throw refusal; };
  await expect(web.signIn()).rejects.toBe(refusal);
  expect(calls.events).toContain("prepare-refused");
  expect(calls.setup).toEqual([]);
});
