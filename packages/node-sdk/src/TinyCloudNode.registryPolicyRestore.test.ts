/**
 * Hydration remains local; authorized live operations resolve current registry
 * routing independently of explicit or persisted host hints.
 */
import { afterEach, expect, test } from "bun:test";
import {
  REGISTRY_NOT_FOUND_BODY,
  createInMemoryRegistryCacheStore,
  createInMemoryRegistrySequenceStore,
  lookupOwnerRegistryVerdict,
  pkhDid,
  signLocationRecord,
  signLocationRecordV2,
  type LocationRecordV2Payload,
  type RegistryCacheStore,
  type RegistrySequenceStore,
} from "@tinycloud/sdk-core";

import { NodeWasmBindings } from "./NodeWasmBindings";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { TinyCloudNode } from "./TinyCloudNode";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

const REGISTRY = "https://registry.test";
const NODE_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";
const ROUTED_HOST = "https://registered-node.test";
const STALE_HOST = "https://stale-node.test";
const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function installNetwork(
  registry: (url: string) => Promise<Response>,
  identityByOrigin: Readonly<Record<string, string>> = { [ROUTED_HOST]: NODE_DID },
): string[] {
  const requests: string[] = [];
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url.startsWith(`${REGISTRY}/`)) return registry(url);
    const origin = new URL(url).origin;
    const nodeDid = identityByOrigin[origin];
    if (origin !== STALE_HOST && origin !== ROUTED_HOST && identityByOrigin[origin] === undefined) {
      throw new TypeError(`unreachable: ${url}`);
    }
    if (url.endsWith("/info")) {
      return Response.json({ protocol: 1, version: "1.0.0", features: [], nodeId: nodeDid ?? NODE_DID });
    }
    if (url.endsWith("/.well-known/tinycloud/node-keys")) {
      return Response.json({
        nodeDid: nodeDid ?? NODE_DID,
        shareInvitationPublicKey: "A".repeat(43),
      });
    }
    if (new URL(url).pathname === "/invoke") return Response.json({ fixture: "routed" });
    throw new TypeError(`unreachable: ${url}`);
  }) as typeof fetch;
  return requests;
}

async function signedV2Record(spaceId: string, url = ROUTED_HOST) {
  const address = await owner.getAddress();
  const payload: LocationRecordV2Payload = {
    version: 2,
    subject: pkhDid(address, 1),
    nodes: [{ did: NODE_DID, url }],
    spaces: [{
      space: spaceId.toLowerCase(),
      nodes: [{ did: NODE_DID, mode: "read-write" }],
    }],
    encryptionNode: NODE_DID,
    updated_at: "2026-10-18T00:00:00.000Z",
    sequence: 1,
  };
  return signLocationRecordV2(payload, {
    type: "did:pkh",
    signMessage: (message) => owner.signMessage(message),
  });
}

function newNode(
  host?: string,
  registrySequenceStore?: RegistrySequenceStore,
  registryCacheStore?: RegistryCacheStore,
): TinyCloudNode {
  return new TinyCloudNode({
    signer: owner,
    wasmBindings: new NodeWasmBindings(),
    ...(host === undefined ? {} : { host }),
    tinycloudRegistryUrl: REGISTRY,
    registrySequenceStore,
    registryCacheStore,
    autoDiscoverLocalNode: false,
  });
}

test("an unknown owner's cold registry outage retains the configured hint only at the live boundary", async () => {
  const requests = installNetwork(async () => new Response("down", { status: 503 }));
  const proof = await signedRestorableSession();
  const node = newNode(STALE_HOST);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({ ok: true });
  expect(requests).toContain(`${REGISTRY}/v2/locations/${encodeURIComponent(proof.address)}`);
  expect(requests).toContain(`${STALE_HOST}/invoke`);
});

test("a signed v2 full-space route overrides stale hints at the authorized live read", async () => {
  const proof = await signedRestorableSession();
  const record = await signedV2Record(proof.spaceId);
  const requests = installNetwork(async () => Response.json({ record }));
  const node = newNode(STALE_HOST);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });
  expect(node.hosts).toEqual([STALE_HOST]);
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({ ok: true });
  expect(requests).toContain(`${ROUTED_HOST}/invoke`);
  expect(requests.some((url) => url.startsWith(`${STALE_HOST}/`))).toBe(false);
  expect(requests.some((url) => url.startsWith(`${REGISTRY}/v1/locations/`))).toBe(false);
});

test("true absence in v2 and v1 uses the configured host hint at the authorized live read", async () => {
  const requests = installNetwork(async () => new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }));
  const node = newNode(STALE_HOST);
  const proof = await signedRestorableSession();

  await node.restoreSession({ ...proof, tinycloudHosts: undefined });
  expect(node.hosts).toEqual([STALE_HOST]);
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({ ok: true });
  expect(requests).toContain(`${REGISTRY}/v2/locations/${encodeURIComponent(proof.address)}`);
  expect(requests).toContain(`${REGISTRY}/v1/locations/${encodeURIComponent(pkhDid(proof.address, 1))}`);
  expect(requests).toContain(`${STALE_HOST}/invoke`);
});

test("a v1-only owner restores locally but the authorized first live read refuses every host hint", async () => {
  const proof = await signedRestorableSession();
  const address = await owner.getAddress();
  const legacy = await signLocationRecord(
    {
      version: 1,
      subject: pkhDid(address, 1),
      multiaddrs: ["/dns4/stale-node.test/tcp/443/https"],
      updated_at: "2026-10-18T00:00:00.000Z",
      sequence: 1,
    },
    { type: "did:pkh", signMessage: (message) => owner.signMessage(message) },
  );
  const requests = installNetwork(async (url) =>
    url.startsWith(`${REGISTRY}/v2/locations/`)
      ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 })
      : Response.json({ record: legacy }),
  );
  const node = newNode(STALE_HOST);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({
    ok: false, error: { code: "registry_unavailable" },
  });
  expect(requests).toContain(`${REGISTRY}/v1/locations/${encodeURIComponent(pkhDid(address, 1))}`);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});

test("verified owner history after authoritative cache drop refuses an unavailable first live read", async () => {
  const proof = await signedRestorableSession();
  const record = await signedV2Record(proof.spaceId);
  const history = createInMemoryRegistrySequenceStore();
  const cache = createInMemoryRegistryCacheStore();
  let phase: "registered" | "revoked" | "down" = "registered";
  const requests = installNetwork(async () => phase === "registered"
    ? Response.json({ record })
    : new Response(phase, { status: phase === "revoked" ? 403 : 503 }));
  const options = { registryUrl: REGISTRY, sequenceStore: history, cacheStore: cache };
  expect(await lookupOwnerRegistryVerdict(pkhDid(proof.address, 1), options))
    .toMatchObject({ status: "registered" });
  phase = "revoked";
  expect(await lookupOwnerRegistryVerdict(pkhDid(proof.address, 1), options))
    .toMatchObject({ status: "unavailable" });
  expect(await cache.get(proof.address)).toBeUndefined();
  phase = "down";
  requests.length = 0;
  const node = newNode(STALE_HOST, history, cache);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({
    ok: false, error: { code: "registry_unavailable" },
  });
  expect(requests).toContain(`${REGISTRY}/v2/locations/${encodeURIComponent(proof.address)}`);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
  expect(await history.get(proof.address)).toBe(record.sequence);
});

test("a changed signed v2 payload refuses the authorized first read before data RPC", async () => {
  const proof = await signedRestorableSession();
  const record = { ...await signedV2Record(proof.spaceId), updated_at: "2026-10-19T00:00:00.000Z" };
  const requests = installNetwork(async () => Response.json({ record }));
  const node = newNode(STALE_HOST);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({
    ok: false, error: { code: "registry_unavailable" },
  });
  expect(requests).toContain(`${REGISTRY}/v2/locations/${encodeURIComponent(proof.address)}`);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});

test("a valid signed v2 record missing the requested space refuses the first live read", async () => {
  const proof = await signedRestorableSession();
  const record = await signedV2Record(proof.spaceId.replace(/:default$/, ":other"));
  const requests = installNetwork(async () => Response.json({ record }));
  const node = newNode(STALE_HOST);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });
  expect(requests).toEqual([]);
  expect(await node.kv.get("route-probe")).toMatchObject({
    ok: false, error: { code: "node_not_found" },
  });
  expect(requests).toContain(`${REGISTRY}/v2/locations/${encodeURIComponent(proof.address)}`);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});
