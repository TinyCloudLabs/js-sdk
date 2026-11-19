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
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

// TC-2944: vault values and names, like encryption calls, only use the
// TEE-terminated origin of the production node; other data keeps its route.
const REGISTRY = "https://registry.test";
const PROXIED = "https://node.tinycloud.xyz";
const TEE = "https://tee.node.tinycloud.xyz";
const CUSTOM = "https://self-hosted.test";
const NODE_DID = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(7))]))}`;
const KV_ABILITIES = { kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list", "tinycloud.kv/del", "tinycloud.kv/metadata"] } };
const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Attempt = { url: string; redirect: RequestRedirect | undefined; invocation?: string };

async function fixture(options: { routedUrl?: string; teeDown?: boolean } = {}) {
  const routedUrl = options.routedUrl ?? PROXIED;
  const proof = await signedRestorableSession({ abilities: KV_ABILITIES, ownedSpaceAbilities: { secrets: KV_ABILITIES } });
  const payload: LocationRecordV2Payload = {
    version: 2, subject: pkhDid(proof.address, 1), nodes: [{ did: NODE_DID, url: routedUrl }],
    spaces: [proof.spaceId, proof.spaces!.secrets!].map((space) => ({ space: space.toLowerCase(), nodes: [{ did: NODE_DID, mode: "read-write" as const }] })),
    encryptionNode: NODE_DID, updated_at: "2026-11-19T00:00:00.000Z", sequence: 1,
  };
  const record = await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => owner.signMessage(message) });
  const attempts: Attempt[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === REGISTRY) {
      const key = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1)).toLowerCase();
      return key === registryOwnerKeyV2(payload.subject).toLowerCase()
        ? Response.json({ record })
        : Response.json({ error: "location record not found" }, { status: 404 });
    }
    const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    attempts.push({ url: url.href, redirect: init?.redirect, ...(url.pathname === "/invoke" && authorization ? { invocation: authorization } : {}) });
    if (url.origin === TEE && options.teeDown) throw new TypeError("fetch failed");
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: [], nodeId: NODE_DID });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: NODE_DID });
    if (url.pathname === "/delegate") return Response.json({});
    if (url.pathname === "/invoke") return new Response("", { status: 404 });
    throw new Error(`Unexpected fixture request ${url.href}`);
  }) as typeof fetch;
  const node = new TinyCloudNode({ signer: owner, wasmBindings: new NodeWasmBindings(), tinycloudRegistryUrl: REGISTRY, autoDiscoverLocalNode: false });
  await node.restoreSession({ ...proof, tinycloudHosts: [routedUrl] });
  return { node, attempts };
}

const invocations = (attempts: Attempt[]) => attempts.filter((attempt) => attempt.invocation !== undefined);
const origins = (attempts: Attempt[]) => new Set(attempts.map((attempt) => new URL(attempt.url).origin));

test("reading secret values on the proxied production name goes only to the TEE origin", async () => {
  const { node, attempts } = await fixture();
  await node.secrets.get("API_KEY");
  await node.secrets.list();
  expect(invocations(attempts).length).toBeGreaterThanOrEqual(2);
  expect(origins(attempts)).toEqual(new Set([TEE]));
  expect(attempts.every((attempt) => attempt.redirect === "error")).toBe(true);
});

test("vault reads, listings, metadata and deletes on the proxied production name go only to the TEE origin", async () => {
  const { node, attempts } = await fixture();
  await node.vault.get("api-key", { source: "network" });
  await node.vault.head("api-key");
  await node.vault.list();
  await node.vault.delete("api-key");
  await node.kv.get("vault/api-key");
  const vaultCalls = invocations(attempts);
  expect(vaultCalls.length).toBeGreaterThanOrEqual(5);
  expect(origins(attempts)).toEqual(new Set([TEE]));
  expect(attempts.every((attempt) => attempt.redirect === "error")).toBe(true);
});

test("ordinary data keeps the routed production name", async () => {
  const { node, attempts } = await fixture();
  await node.kv.get("notes");
  expect(origins(invocations(attempts))).toEqual(new Set([PROXIED]));
});

test("a TEE failure fails the vault call and never reaches the proxied name", async () => {
  const { node, attempts } = await fixture({ teeDown: true });
  const result = await node.vault.get("api-key", { source: "network" });
  expect(result.ok).toBe(false);
  expect(await node.kv.get("vault/api-key")).toMatchObject({ ok: false, error: { code: "NODE_NOT_RESPONDING" } });
  expect(attempts.length).toBeGreaterThan(0);
  expect(origins(attempts)).toEqual(new Set([TEE]));
});

test("a self-hosted node keeps its own origin for vault traffic", async () => {
  const { node, attempts } = await fixture({ routedUrl: CUSTOM });
  await node.vault.list();
  expect(origins(attempts)).toEqual(new Set([CUSTOM]));
});
