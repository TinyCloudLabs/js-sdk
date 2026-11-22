import { expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey, type PrivateKeyAccount } from "viem/accounts";
import { lookupOwnerRegistryVerdict, signLocationRecordV2 } from "@tinycloud/sdk-core";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { ensureOwnerRegistryRecord, isRegistryRecordSignRefusal, REGISTRY_PUBLISH_ORIGINS } from "./registry-publish";

// Fresh ed25519 key for the node so `verifyResourceDestination`'s /info and
// /.well-known/tinycloud/node-keys checks resolve. Mirrors the sdk-core publication
// test fixture (packages/sdk-core/src/location-publication.test.ts).
const NODE_PUBLIC = ed25519.getPublicKey(new Uint8Array(32).fill(7));
const NODE_DID = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...NODE_PUBLIC))}`;
const NODE_ORIGIN = "https://node.test.local";
const REGISTRY_URL = "http://localhost:12345";
const ONE_ORIGIN = "https://tinycloud.one";
const THIRD_PARTY_ORIGIN = "https://chat.example.com";

function makeWalletOwner() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const subject = `did:pkh:eip155:1:${address}`;
  const space = `tinycloud:pkh:eip155:1:${address.toLowerCase()}:default`;
  return { account, address, subject, space };
}

function makeFakeNode(options: { subject: string; space: string }): TinyCloudNode {
  return {
    spaceId: options.space,
    did: options.subject,
    async activeNodeIdentity() {
      return { nodeDid: NODE_DID, origin: NODE_ORIGIN };
    },
  } as unknown as TinyCloudNode;
}

// A fetch that models the location registry and the node's identity probe: GET on the
// registry returns 404 until a PUT seeds it, after which GET returns the signed record.
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

function makeSigner(subject: string, account: PrivateKeyAccount) {
  return { subject, signMessage: (message: string) => account.signMessage({ message }) };
}

test("TinyCloud One and Home: unregistered owner is published, and the PUT lists only the SDK's active node", async () => {
  expect([...REGISTRY_PUBLISH_ORIGINS].sort()).toEqual(["https://home.tinycloud.xyz", "https://tinycloud.one"]);
  for (const origin of REGISTRY_PUBLISH_ORIGINS) {
    const owner = makeWalletOwner();
    let seenPut: Record<string, unknown> | undefined;
    const fetch = makeMockRegistry((record) => { seenPut = record; });
    const outcome = await ensureOwnerRegistryRecord({
      node: makeFakeNode(owner), subject: owner.subject, origin, registryUrl: REGISTRY_URL, fetch,
      resolveSigner: async () => makeSigner(owner.subject, owner.account),
    });
    expect(outcome).toBe("published");
    const put = seenPut as { subject: string; nodes: { did: string; url: string }[]; spaces: { space: string; nodes: { did: string }[] }[] };
    expect(put.subject).toBe(owner.subject);
    expect(put.nodes).toEqual([{ did: NODE_DID, url: NODE_ORIGIN }]);
    expect(put.spaces).toEqual([{ space: owner.space, nodes: [{ did: NODE_DID, mode: "read-write" }] }]);
  }
});

test("any other origin: unregistered owner gets needs-one, nothing is signed and the registry is never PUT", async () => {
  for (const origin of [THIRD_PARTY_ORIGIN, "https://tinycloud.one.evil.example", "http://tinycloud.one", undefined]) {
    const owner = makeWalletOwner();
    let putSeen = false;
    const fetch = makeMockRegistry(() => { putSeen = true; });
    const outcome = await ensureOwnerRegistryRecord({
      node: makeFakeNode(owner), subject: owner.subject, origin, registryUrl: REGISTRY_URL, fetch,
      resolveSigner: async () => { throw new Error("signer must not be resolved for an origin that cannot publish"); },
    });
    expect(outcome).toBe("needs-one");
    expect(putSeen).toBe(false);
  }
});

test("registered owner on any origin: already-current, no signer, no PUT", async () => {
  const owner = makeWalletOwner();
  const baseFetch = makeMockRegistry();
  await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: REGISTRY_URL, fetch: baseFetch,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  let putObserved = false;
  const trackingFetch: typeof globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") putObserved = true;
    return baseFetch(input, init);
  };
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: THIRD_PARTY_ORIGIN, registryUrl: REGISTRY_URL, fetch: trackingFetch,
    resolveSigner: async () => { throw new Error("signer must not be resolved when the owner is registered"); },
  });
  expect(outcome).toBe("already-current");
  expect(putObserved).toBe(false);
});

test("OpenKey refuses the registry-record signature: needs-one, nothing PUT", async () => {
  const refusals: unknown[] = [
    Object.assign(new Error("Only TinyCloud One can request a signature that sets the account's node location through OpenKey. Nothing was signed."), { code: "registry_record_sign_refused" }),
    new Error("REGISTRY_RECORD_SIGN_REFUSED"),
    new Error("sign failed", { cause: new Error("REGISTRY_RECORD_SIGN_REFUSED") }),
  ];
  for (const refusal of refusals) {
    const owner = makeWalletOwner();
    let putSeen = false;
    let errors = 0;
    const fetch = makeMockRegistry(() => { putSeen = true; });
    const outcome = await ensureOwnerRegistryRecord({
      node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: REGISTRY_URL, fetch,
      resolveSigner: async () => ({ subject: owner.subject, signMessage: async () => { throw refusal; } }),
      onError: () => { errors++; },
    });
    expect(outcome).toBe("needs-one");
    expect(putSeen).toBe(false);
    expect(errors).toBe(0);
  }
});

test("a signing failure that is not the refusal stays unavailable and is reported", async () => {
  const owner = makeWalletOwner();
  let errors = 0;
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: REGISTRY_URL, fetch: makeMockRegistry(),
    resolveSigner: async () => ({ subject: owner.subject, signMessage: async () => { throw new Error("user closed the wallet"); } }),
    onError: () => { errors++; },
  });
  expect(outcome).toBe("unavailable");
  expect(errors).toBe(1);
});

test("isRegistryRecordSignRefusal matches only OpenKey's refusal code or message", () => {
  expect(isRegistryRecordSignRefusal({ code: "registry_record_sign_refused" })).toBe(true);
  expect(isRegistryRecordSignRefusal(new Error("REGISTRY_RECORD_SIGN_REFUSED"))).toBe(true);
  expect(isRegistryRecordSignRefusal(new Error("Managed-key signing requires an OpenKey browser origin"))).toBe(false);
  expect(isRegistryRecordSignRefusal("REGISTRY_RECORD_SIGN_REFUSED")).toBe(false);
  expect(isRegistryRecordSignRefusal(undefined)).toBe(false);
});

test("registry URL explicitly disabled (null) → unavailable", async () => {
  const owner = makeWalletOwner();
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: null,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("unavailable");
});

test("primary space missing → unavailable, signer never resolved", async () => {
  const owner = makeWalletOwner();
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode({ subject: owner.subject, space: "" }), subject: owner.subject, origin: ONE_ORIGIN,
    registryUrl: REGISTRY_URL, fetch: makeMockRegistry(),
    resolveSigner: async () => { throw new Error("signer must not be resolved without a primary space"); },
  });
  expect(outcome).toBe("unavailable");
});

test("after a publish from TinyCloud One the owner's verdict is `registered`, so the third-party sign-in gate no longer refuses", async () => {
  const owner = makeWalletOwner();
  const fetch = makeMockRegistry();
  const before = await lookupOwnerRegistryVerdict(owner.subject, { registryUrl: REGISTRY_URL, fetch, dataRead: true });
  expect(before.status).toBe("unregistered");
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: REGISTRY_URL, fetch,
    resolveSigner: async () => makeSigner(owner.subject, owner.account),
  });
  expect(outcome).toBe("published");
  const after = await lookupOwnerRegistryVerdict(owner.subject, { registryUrl: REGISTRY_URL, fetch, dataRead: true });
  expect(after.status).toBe("registered");
});

test("a record appears between the verdict check and the publish → unavailable, no PUT, no merge", async () => {
  const owner = makeWalletOwner();
  // A competing record signed by the same owner and listing a different node. Without the
  // no-overwrite fence, publishing would merge this SDK's node into it.
  const OTHER_NODE_PUBLIC = ed25519.getPublicKey(new Uint8Array(32).fill(9));
  const OTHER_NODE_DID = `did:key:${base58btc.encode(Uint8Array.of(0xed, 0x01, ...OTHER_NODE_PUBLIC))}`;
  const OTHER_NODE_ORIGIN = "https://other-node.test.local";
  const planted = await signLocationRecordV2({
    version: 2, subject: owner.subject,
    nodes: [{ did: OTHER_NODE_DID, url: OTHER_NODE_ORIGIN }],
    spaces: [{ space: owner.space, nodes: [{ did: OTHER_NODE_DID, mode: "read-write" }] }],
    encryptionNode: null,
    updated_at: "2026-11-21T13:00:00.000Z",
    sequence: 0,
  }, { type: "did:pkh", signMessage: (m) => owner.account.signMessage({ message: m }) });

  let putAttempts = 0;
  let registered: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${NODE_ORIGIN}/info`) return Response.json({ nodeId: NODE_DID });
    if (url === `${NODE_ORIGIN}/.well-known/tinycloud/node-keys`) return Response.json({ nodeDid: NODE_DID });
    if (url === `${OTHER_NODE_ORIGIN}/info`) return Response.json({ nodeId: OTHER_NODE_DID });
    if (url === `${OTHER_NODE_ORIGIN}/.well-known/tinycloud/node-keys`) return Response.json({ nodeDid: OTHER_NODE_DID });
    if (!url.startsWith(REGISTRY_URL)) return new Response(`unexpected URL ${url}`, { status: 599 });
    if (!init || !init.method || init.method === "GET") {
      if (registered) return new Response(JSON.stringify({ record: registered }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "location record not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }
    if (init.method === "PUT") { putAttempts++; return new Response("refused: test should not PUT", { status: 599 }); }
    return new Response(`unexpected method ${init.method}`, { status: 599 });
  };
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: REGISTRY_URL, fetch,
    // The record lands while the signer is being resolved, after the verdict said `unregistered`.
    resolveSigner: async () => { registered = { ...planted }; return makeSigner(owner.subject, owner.account); },
  });
  expect(outcome).toBe("unavailable");
  expect(putAttempts).toBe(0);
});

test("cold registry (503) → unavailable, no signer, no PUT", async () => {
  const owner = makeWalletOwner();
  let putAttempts = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (init?.method === "PUT") { putAttempts++; return new Response("refused: test should not PUT", { status: 599 }); }
    return new Response("cold", { status: 503 });
  };
  const outcome = await ensureOwnerRegistryRecord({
    node: makeFakeNode(owner), subject: owner.subject, origin: ONE_ORIGIN, registryUrl: REGISTRY_URL, fetch,
    resolveSigner: async () => { throw new Error("signer must not be resolved on a cold registry"); },
  });
  expect(outcome).toBe("unavailable");
  expect(putAttempts).toBe(0);
});
