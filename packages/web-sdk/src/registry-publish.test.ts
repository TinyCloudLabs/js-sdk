import { expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
// lookupOwnerRegistryVerdict is what the TC-2931 gate consults; the acceptance test below
// asserts a publish moves the verdict from `unregistered` to `registered`, which is the
// precise observable the third-party sign-in gate checks.
import { lookupOwnerRegistryVerdict } from "@tinycloud/sdk-core";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { ensureOwnerRegistryRecord, type RegistryPublishPreview } from "./registry-publish";

// Shared test fixtures --------------------------------------------------------

// Fresh ed25519 key for the node so `verifyResourceDestination`'s /info and
// /.well-known/tinycloud/node-keys checks resolve. Mirrors the sdk-core publication
// test fixture (packages/sdk-core/src/location-publication.test.ts).
const NODE_PUBLIC = ed25519.getPublicKey(new Uint8Array(32).fill(7));
const NODE_DID = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...NODE_PUBLIC))}`;
const NODE_ORIGIN = "https://node.test.local";
const REGISTRY_URL = "http://localhost:12345";
const ACCOUNT_SPACE = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000aa:account-registry";

function makeWalletOwner() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const subject = `did:pkh:eip155:1:${address}`;
  const space = `tinycloud:pkh:eip155:1:${address.toLowerCase()}:default`;
  return { account, address, subject, space };
}

interface FakeNodeOptions {
  subject: string;
  space: string;
  accountSpaceId?: string | undefined;
  activeNodeOverride?: { nodeDid: string; origin: string };
  dismissedFlag?: boolean;
}

function makeFakeNode(options: FakeNodeOptions): TinyCloudNode {
  const kvStore = new Map<string, unknown>();
  if (options.dismissedFlag) kvStore.set("system/registry-publish/dismissed/v1", { dismissed: true, at: new Date().toISOString() });
  const kv = {
    async get<T>(key: string) { return { ok: true as const, data: { data: kvStore.get(key) as T | undefined, headers: {} } }; },
    async put(key: string, value: unknown) { kvStore.set(key, value); },
  };
  return {
    accountSpaceId: options.accountSpaceId,
    spaceId: options.space,
    did: options.subject,
    kvForSpace(spaceId: string) {
      if (spaceId !== options.accountSpaceId) throw new Error(`kvForSpace called for wrong space: ${spaceId}`);
      return kv;
    },
    async activeNodeIdentity() {
      return options.activeNodeOverride ?? { nodeDid: NODE_DID, origin: NODE_ORIGIN };
    },
  } as unknown as TinyCloudNode;
}

// Build a fetch that models the location registry's canonical answers AND the node's
// identity probe: GET REGISTRY_URL/... returns a 404 until a PUT seeds it, after which
// GET returns 200 with the signed record; GET NODE_ORIGIN/info and
// /.well-known/tinycloud/node-keys report the node's own did:key so
// `verifyResourceDestination` accepts the record before publishing.
function makeMockRegistry(onPut?: (record: unknown) => void): typeof globalThis.fetch {
  let registered: Record<string, unknown> | undefined;
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${NODE_ORIGIN}/info`) return Response.json({ nodeId: NODE_DID });
    if (url === `${NODE_ORIGIN}/.well-known/tinycloud/node-keys`) return Response.json({ nodeDid: NODE_DID });
    if (!url.startsWith(REGISTRY_URL)) return new Response(`unexpected URL ${url}`, { status: 599 });
    if (!init || !init.method || init.method === "GET") {
      if (registered) return new Response(JSON.stringify({ record: registered }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "location record not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (init.method === "PUT") {
      const body = typeof init.body === "string" ? init.body : "";
      const record = JSON.parse(body) as Record<string, unknown>;
      onPut?.(record);
      registered = record;
      return new Response(JSON.stringify({ record, status: "created" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(`unexpected method ${init.method}`, { status: 599 });
  };
}

// Lockstep across 7 call sites; viem's PrivateKeyAccount is the named signer type.
function makeSigner(subject: string, account: PrivateKeyAccount) {
  return { subject, signMessage: (message: string) => account.signMessage({ message }) };
}

// Tests -----------------------------------------------------------------------

test("verdict unregistered + consent accepts → publishes and PUT uses the SDK's active-node identity only", async () => {
  const owner = makeWalletOwner();
  let seenPreview: RegistryPublishPreview | undefined;
  let seenPut: Record<string, unknown> | undefined;
  const fetch = makeMockRegistry((record) => { seenPut = record; });
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE });
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async (preview) => { seenPreview = preview; return true; },
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("published");
  expect(seenPreview).toEqual({ subject: owner.subject, nodeDid: NODE_DID, nodeOrigin: NODE_ORIGIN, space: owner.space });
  // Bobbie req. 1: the PUT payload lists only the verified active node, not any caller input.
  expect(seenPut).toBeDefined();
  const put = seenPut as { subject: string; nodes: { did: string; url: string }[]; spaces: { space: string; nodes: { did: string }[] }[] };
  expect(put.subject).toBe(owner.subject);
  expect(put.nodes).toEqual([{ did: NODE_DID, url: NODE_ORIGIN }]);
  expect(put.spaces).toEqual([{ space: owner.space, nodes: [{ did: NODE_DID, mode: "read-write" }] }]);
});

test("verdict registered → already-current, registry not asked to PUT", async () => {
  // Pre-seed the registry with a valid record so the GET returns 200 and the verdict is `registered`.
  const owner = makeWalletOwner();
  const baseFetch = makeMockRegistry();
  // First seed the registry with a published record by doing one publish, then test a second call
  // sees it as `registered` and returns `already-current` with no PUT on the second attempt.
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE });
  await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch: baseFetch,
    onConsent: async () => true,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  let secondPutObserved = false;
  const trackingFetch: typeof globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") secondPutObserved = true;
    return baseFetch(input, init);
  };
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch: trackingFetch,
    onConsent: async () => { throw new Error("consent must not be prompted when verdict is registered"); },
    resolveSigner: async () => { throw new Error("signer must not be resolved when verdict is registered"); },
  });
  expect(outcome).toBe("already-current");
  expect(secondPutObserved).toBe(false);
});

test("no onConsent callback → declined, registry never contacted beyond the verdict lookup", async () => {
  const owner = makeWalletOwner();
  let putSeen = false;
  const fetch = makeMockRegistry(() => { putSeen = true; });
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE });
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("declined");
  expect(putSeen).toBe(false);
});

test("onConsent returns false → declined, dismissed flag persisted, registry not PUT", async () => {
  const owner = makeWalletOwner();
  let putSeen = false;
  const fetch = makeMockRegistry(() => { putSeen = true; });
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE });
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async () => false,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("declined");
  expect(putSeen).toBe(false);
  // The second attempt short-circuits immediately on the persisted dismissed flag, before verdict lookup.
  let consentCount = 0;
  const outcome2 = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async () => { consentCount++; return true; },
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome2).toBe("declined");
  expect(consentCount).toBe(0);
});

test("ignoreDismissed bypasses the dismissed flag but still requires consent + unregistered (TC-3547 finish-setup=registry)", async () => {
  const owner = makeWalletOwner();
  const fetch = makeMockRegistry();
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE, dismissedFlag: true });
  // Without ignoreDismissed the dismissed flag short-circuits even though consent would accept.
  const declined = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async () => true,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(declined).toBe("declined");
  // With ignoreDismissed the consent runs and the publish completes.
  const published = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    ignoreDismissed: true,
    onConsent: async () => true,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(published).toBe("published");
});

test("registry URL explicitly disabled (null) → unavailable", async () => {
  const owner = makeWalletOwner();
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE }),
    subject: owner.subject,
    registryUrl: null,
    onConsent: async () => true,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("unavailable");
});

test("signer subject mismatch → unavailable, onError informed, registry never PUT", async () => {
  const owner = makeWalletOwner();
  const impostor = makeWalletOwner();
  let errors = 0;
  let putSeen = false;
  const fetch = makeMockRegistry(() => { putSeen = true; });
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE });
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async () => true,
    // Returns a signer whose declared subject disagrees with the node owner — refused.
    resolveSigner: async () => makeSigner(impostor.subject, impostor.account),
    onError: () => { errors++; },
  });
  expect(outcome).toBe("unavailable");
  expect(errors).toBe(1);
  expect(putSeen).toBe(false);
});

test("primary space missing → unavailable, consent never prompted", async () => {
  const owner = makeWalletOwner();
  let consented = false;
  const fetch = makeMockRegistry();
  const node = makeFakeNode({ subject: owner.subject, space: "", accountSpaceId: ACCOUNT_SPACE });
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async () => { consented = true; return true; },
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("unavailable");
  expect(consented).toBe(false);
});

test("TC-3547 acceptance: after a successful first-party publish, the owner's verdict is `registered` so the TC-2931 third-party gate no longer refuses", async () => {
  const owner = makeWalletOwner();
  const fetch = makeMockRegistry();
  const node = makeFakeNode({ subject: owner.subject, space: owner.space, accountSpaceId: ACCOUNT_SPACE });
  // Precondition: the verdict is `unregistered` — exactly the state TC-2931 refuses third-party on.
  const before = await lookupOwnerRegistryVerdict(owner.subject, { registryUrl: REGISTRY_URL, fetch, dataRead: true });
  expect(before.status).toBe("unregistered");
  const outcome = await ensureOwnerRegistryRecord({
    node, subject: owner.subject, registryUrl: REGISTRY_URL, fetch,
    onConsent: async () => true,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("published");
  // Postcondition: the same verdict lookup (the one `NodeUserAuthorization.resolveResourceDestinations` uses)
  // now returns `registered`, so the gate's `if (this.requireExistingAccount && verdict.status === "unregistered")`
  // branch at NodeUserAuthorization.ts:757-764 no longer fires. This is the direct TC-3547 acceptance observable.
  const after = await lookupOwnerRegistryVerdict(owner.subject, { registryUrl: REGISTRY_URL, fetch, dataRead: true });
  expect(after.status).toBe("registered");
});
