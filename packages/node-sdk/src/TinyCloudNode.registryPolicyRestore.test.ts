/**
 * Restored-session routing is registry-first. Explicit and persisted hosts are
 * onboarding hints only; a registered v2 full-space route wins.
 */
import { afterEach, expect, test } from "bun:test";
import {
  REGISTRY_NOT_FOUND_BODY,
  RegistryUnavailableError,
  pkhDid,
  signLocationRecord,
  signLocationRecordV2,
  type LocationRecordV2Payload,
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
    const url = String(input);
    requests.push(url);
    if (url.startsWith(`${REGISTRY}/`)) return registry(url);
    const origin = new URL(url).origin;
    const nodeDid = identityByOrigin[origin];
    if (url.endsWith("/info")) {
      return Response.json({ protocol: 1, version: "1.0.0", features: [], nodeId: nodeDid ?? NODE_DID });
    }
    if (url.endsWith("/.well-known/tinycloud/node-keys")) {
      return Response.json({
        nodeDid: nodeDid ?? NODE_DID,
        shareInvitationPublicKey: "A".repeat(43),
      });
    }
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

function newNode(host?: string): TinyCloudNode {
  return new TinyCloudNode({
    signer: owner,
    wasmBindings: new NodeWasmBindings(),
    ...(host === undefined ? {} : { host }),
    tinycloudRegistryUrl: REGISTRY,
    autoDiscoverLocalNode: false,
  });
}

test("an unavailable registry fails restored-session resolution before any host hint", async () => {
  const requests = installNetwork(async () => new Response("down", { status: 503 }));
  const proof = await signedRestorableSession();

  await expect(newNode().restoreSession({ ...proof, tinycloudHosts: undefined }))
    .rejects.toBeInstanceOf(RegistryUnavailableError);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});

test("a signed v2 full-space route overrides explicit and persisted stale hosts", async () => {
  const proof = await signedRestorableSession();
  const record = await signedV2Record(proof.spaceId);
  const address = await owner.getAddress();
  const requests = installNetwork(async (url) =>
    url === `${REGISTRY}/v2/locations/${encodeURIComponent(address)}`
      ? Response.json({ record })
      : new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }),
  );
  const node = newNode(STALE_HOST);

  await node.restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] });

  expect(node.hosts).toEqual([ROUTED_HOST]);
  expect(requests.some((url) => url.startsWith(`${STALE_HOST}/`))).toBe(false);
  expect(requests.some((url) => url.startsWith(`${REGISTRY}/v1/locations/`))).toBe(false);
});

test("a true absence in v2 and v1 restores through the configured host hint", async () => {
  const address = await owner.getAddress();
  const requests = installNetwork(async () => new Response(REGISTRY_NOT_FOUND_BODY, { status: 404 }));
  const node = newNode(STALE_HOST);
  const proof = await signedRestorableSession();

  await node.restoreSession({ ...proof, tinycloudHosts: undefined });

  expect(node.hosts).toEqual([STALE_HOST]);
  expect(requests).toContain(`${REGISTRY}/v2/locations/${encodeURIComponent(address)}`);
  expect(requests).toContain(`${REGISTRY}/v1/locations/${encodeURIComponent(pkhDid(address, 1))}`);
});

test("a v1-only owner is unavailable and cannot restore through explicit or persisted stale hosts", async () => {
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

  await expect(newNode(STALE_HOST).restoreSession({ ...proof, tinycloudHosts: [STALE_HOST] }))
    .rejects.toBeInstanceOf(RegistryUnavailableError);
  expect(requests.every((url) => url.startsWith(`${REGISTRY}/`))).toBe(true);
});
