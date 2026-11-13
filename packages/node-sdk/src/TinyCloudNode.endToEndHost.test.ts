import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import {
  pkhDid,
  registryOwnerKeyV2,
  signLocationRecordV2,
  type LocationRecordV2Payload,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import { createNamedKeyClient } from "./encryption-keys";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

// TC-2923: encryption-network traffic for the production node uses only the
// TEE-terminated origin; everything else keeps the routed host.
const REGISTRY = "https://registry.test";
const PROXIED = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";
const CUSTOM = "https://self-hosted.test";
const NODE_DID = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(7))]))}`;
const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Attempt = { url: string; method: string; redirect: RequestRedirect | undefined };

async function fixture(options: { routedUrl?: string; teeDown?: boolean; unregistered?: boolean } = {}) {
  const routedUrl = options.routedUrl ?? PROXIED;
  const proof = await signedRestorableSession({ abilities: { kv: { "": ["tinycloud.kv/get"] } } });
  const payload: LocationRecordV2Payload = {
    version: 2, subject: pkhDid(proof.address, 1), nodes: [{ did: NODE_DID, url: routedUrl }],
    spaces: [{ space: proof.spaceId.toLowerCase(), nodes: [{ did: NODE_DID, mode: "read-write" }] }],
    encryptionNode: NODE_DID, updated_at: "2026-11-13T00:00:00.000Z", sequence: 1,
  };
  const record = await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => owner.signMessage(message) });
  const attempts: Attempt[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    attempts.push({ url: url.href, method: init?.method ?? "GET", redirect: init?.redirect });
    if (url.origin === REGISTRY) {
      const key = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1)).toLowerCase();
      return key === registryOwnerKeyV2(payload.subject).toLowerCase() && !options.unregistered
        ? Response.json({ record })
        : Response.json({ error: "location record not found" }, { status: 404 });
    }
    if (url.origin === TEE && options.teeDown) return new Response("unavailable", { status: 503 });
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: ["encryption-named-keys-v1"], nodeId: NODE_DID });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: NODE_DID });
    if (url.pathname.startsWith("/encryption/networks/")) {
      if (url.pathname.includes("/keys/")) return Response.json({ error: "key_not_found" }, { status: 404 });
      return Response.json({ descriptor: { networkId: decodeURIComponent(url.pathname.split("/")[3]!), publicEncryptionKey: url.origin } });
    }
    throw new Error(`Unexpected fixture request ${url.href}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({ signer: owner, wasmBindings: new NodeWasmBindings(), tinycloudRegistryUrl: REGISTRY, autoDiscoverLocalNode: false });
  await node.restoreSession({ ...proof, tinycloudHosts: [routedUrl] });
  return { node, attempts };
}

const nodeOrigins = (attempts: Attempt[]) => attempts.map((attempt) => new URL(attempt.url).origin).filter((origin) => origin !== REGISTRY);

test("encryption calls for the proxied production name use only the TEE origin, identity-checked there first", async () => {
  const { node, attempts } = await fixture();
  const descriptor = await node.getEncryptionNetwork();
  expect(descriptor).toMatchObject({ publicEncryptionKey: TEE });
  expect(new Set(nodeOrigins(attempts))).toEqual(new Set([TEE]));
  const urls = attempts.map((attempt) => attempt.url);
  const descriptorRead = urls.findIndex((url) => url.startsWith(`${TEE}/encryption/networks/`));
  expect(urls.slice(0, descriptorRead)).toContain(`${TEE}/info`);
  expect(urls.slice(0, descriptorRead)).toContain(`${TEE}/.well-known/tinycloud/node-keys`);
  expect(attempts.filter((attempt) => new URL(attempt.url).origin === TEE).every((attempt) => attempt.redirect === "error")).toBe(true);

  // Data routing is unchanged: the same session's node identity still names the proxied origin.
  expect(await node.activeNodeIdentity()).toMatchObject({ origin: PROXIED });
});

test("a session restored on the proxied name reads keys through the TEE origin on every call", async () => {
  const { node, attempts } = await fixture();
  await node.getEncryptionNetwork();
  await node.getEncryptionNetwork();
  const descriptorReads = attempts.filter((attempt) => attempt.url.includes("/encryption/networks/"));
  expect(descriptorReads.map((attempt) => new URL(attempt.url).origin)).toEqual([TEE, TEE]);

  const keys = createNamedKeyClient(node);
  await expect(keys.getPublicKey("apps/demo/key")).rejects.toThrow();
  const keyCalls = attempts.slice(attempts.indexOf(descriptorReads[1]!) + 1);
  expect(keyCalls.map((attempt) => new URL(attempt.url).origin)).toEqual([TEE, TEE]);
  expect(keyCalls.map((attempt) => new URL(attempt.url).pathname)).toEqual(["/info", expect.stringContaining("/keys/apps/demo/key")]);
  expect(keyCalls.every((attempt) => attempt.redirect === "error")).toBe(true);
  expect(nodeOrigins(attempts)).not.toContain(PROXIED);
});

test("a TEE failure fails the encryption call and never reaches the proxied name, including on retry", async () => {
  const { node, attempts } = await fixture({ teeDown: true });
  await expect(node.getEncryptionNetwork()).rejects.toMatchObject({ code: "NODE_NOT_RESPONDING" });
  await expect(node.getEncryptionNetwork()).rejects.toMatchObject({ code: "NODE_NOT_RESPONDING" });
  const keys = createNamedKeyClient(node);
  await expect(keys.getPublicKey("apps/demo/key")).rejects.toThrow();
  expect(nodeOrigins(attempts).length).toBeGreaterThan(0);
  expect(nodeOrigins(attempts)).not.toContain(PROXIED);
});

test("an owner with no registry record takes the TEE origin's identity from that origin, not the proxied name", async () => {
  const { node, attempts } = await fixture({ unregistered: true });
  await node.getEncryptionNetwork();
  expect(new Set(nodeOrigins(attempts))).toEqual(new Set([TEE]));
  expect(attempts.find((attempt) => attempt.url === `${TEE}/info`)?.redirect).toBe("error");
});

test("a self-hosted node keeps its own origin for encryption calls", async () => {
  const { node, attempts } = await fixture({ routedUrl: CUSTOM });
  await node.getEncryptionNetwork();
  expect(new Set(nodeOrigins(attempts))).toEqual(new Set([CUSTOM]));
});
