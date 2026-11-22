import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { base58btc } from "multiformats/bases/base58";
import {
  importPortableDelegation,
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
const NETWORK_PUBLIC_KEY = x25519.getPublicKey(new Uint8Array(32).fill(9));
const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Attempt = { url: string; redirect: RequestRedirect | undefined; invocation?: string };

async function fixture(options: { routedUrl?: string; teeDown?: boolean; invokeStatus?: number; abilities?: typeof KV_ABILITIES | { kv: Record<string, string[]> } } = {}) {
  const routedUrl = options.routedUrl ?? PROXIED;
  const proof = await signedRestorableSession({ abilities: options.abilities ?? KV_ABILITIES, ownedSpaceAbilities: { secrets: KV_ABILITIES } });
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
    if (url.pathname.startsWith("/encryption/networks/")) {
      const networkId = decodeURIComponent(url.pathname.slice("/encryption/networks/".length));
      return Response.json({
        networkId, ownerDid: payload.subject, name: "default", members: [{ nodeId: NODE_DID, role: "primary" }],
        threshold: { n: 1, t: 1 }, state: "active", publicEncryptionKey: Buffer.from(NETWORK_PUBLIC_KEY).toString("base64"),
        alg: "x25519-aes256gcm/v1", keyVersion: 1, keyBackend: "local-one-of-one",
        createdAt: "2026-11-19T00:00:00.000Z", updatedAt: "2026-11-19T00:00:00.000Z",
      });
    }
    if (url.pathname === "/invoke") return new Response("", { status: options.invokeStatus ?? 404 });
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
  await node.secrets.get("API_KEY", { requestPermission: true });
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

test("vault writes and key and grant requests on the proxied production name go only to the TEE origin", async () => {
  const { node, attempts } = await fixture({ invokeStatus: 200 });
  expect(await node.vault.put("api-key", "value")).toMatchObject({ ok: true });
  await node.kv.put("vault/raw", "ciphertext");
  await node.kv.get("keys/signing");
  await node.kv.list({ prefix: "grants/" });
  const writes = invocations(attempts);
  expect(writes.length).toBeGreaterThanOrEqual(4);
  expect(attempts.some((attempt) => new URL(attempt.url).pathname.startsWith("/encryption/networks/"))).toBe(true);
  expect(origins(attempts)).toEqual(new Set([TEE]));
  expect(attempts.every((attempt) => attempt.redirect === "error")).toBe(true);
});

test("ordinary data keeps the routed production name", async () => {
  const { node, attempts } = await fixture();
  await node.kv.get("notes");
  expect(origins(invocations(attempts))).toEqual(new Set([PROXIED]));
});

test("listing the whole key space, which names vault entries, goes only to the TEE origin", async () => {
  const { node, attempts } = await fixture();
  await node.kv.list();
  await node.kv.list({ prefix: "" });
  expect(invocations(attempts).length).toBeGreaterThanOrEqual(2);
  expect(origins(attempts)).toEqual(new Set([TEE]));
  expect(attempts.every((attempt) => attempt.redirect === "error")).toBe(true);
});

test("listing an ordinary prefix keeps the routed production name", async () => {
  const { node, attempts } = await fixture();
  await node.kv.list({ prefix: "notes/" });
  expect(invocations(attempts).length).toBeGreaterThanOrEqual(1);
  expect(origins(invocations(attempts))).toEqual(new Set([PROXIED]));
});

test("a TEE failure fails the vault call and never reaches the proxied name", async () => {
  const { node, attempts } = await fixture({ teeDown: true });
  const result = await node.vault.get("api-key", { source: "network" });
  expect(result.ok).toBe(false);
  expect(await node.kv.get("vault/api-key")).toMatchObject({ ok: false, error: { code: "NODE_NOT_RESPONDING" } });
  expect((await node.vault.list()).ok).toBe(false);
  expect((await node.vault.head("api-key")).ok).toBe(false);
  expect((await node.vault.put("api-key", "value")).ok).toBe(false);
  expect(attempts.length).toBeGreaterThan(0);
  expect(attempts.filter((attempt) => new URL(attempt.url).origin === PROXIED)).toEqual([]);
  expect(origins(attempts)).toEqual(new Set([TEE]));
});

test("grants are posted to the TEE origin when they name or cover vault data or cannot be read, and keep their route otherwise", async () => {
  const posted: string[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    posted.push(new URL(input instanceof Request ? input.url : String(input)).origin);
    redirects.push(init?.redirect);
    return Response.json({ activated: [], skipped: [] });
  }) as typeof fetch;
  const ordinary = await signedRestorableSession({ abilities: { kv: { "notes/": ["tinycloud.kv/get"] } } });
  const wholeKeySpace = await signedRestorableSession({ abilities: KV_ABILITIES });
  const secrets = await signedRestorableSession({ abilities: KV_ABILITIES, ownedSpaceAbilities: { secrets: KV_ABILITIES } });
  const vaultPath = await signedRestorableSession({ abilities: { kv: { "vault/api-key": ["tinycloud.kv/get"] } } });
  const unreadable = { Authorization: "not-a-signed-grant" };
  const importOn = (delegationHeader: { Authorization: string }) => importPortableDelegation(globalThis.fetch, PROXIED, {
    cid: "bafy-grant", delegationHeader, ownerAddress: ordinary.address, chainId: 1,
    spaceId: ordinary.spaceId, path: "", actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + 60_000),
    delegateDID: NODE_DID,
  });

  for (const header of [ordinary.delegationHeader, wholeKeySpace.delegationHeader, secrets.delegationHeader, vaultPath.delegationHeader, unreadable]) {
    await importOn(header);
  }
  expect(posted).toEqual([PROXIED, TEE, TEE, TEE, TEE]);
  expect(redirects).toEqual(["error", "error", "error", "error", "error"]);
});

test("under a session that grants the whole key space, every vault invocation and every grant touching vault goes only to the TEE origin", async () => {
  const { node, attempts } = await fixture();
  await node.vault.get("api-key", { source: "network" });
  await node.vault.list();
  await node.kv.get("vault/api-key");
  await node.kv.list();
  const wholeKeySpace = await signedRestorableSession({ abilities: KV_ABILITIES });
  const vaultPath = await signedRestorableSession({ abilities: { kv: { "vault/api-key": ["tinycloud.kv/get"] } } });
  for (const grant of [wholeKeySpace, vaultPath]) {
    await importPortableDelegation(globalThis.fetch, PROXIED, {
      cid: "bafy-grant", delegationHeader: grant.delegationHeader, ownerAddress: grant.address, chainId: 1,
      spaceId: grant.spaceId, path: "", actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + 60_000),
      delegateDID: NODE_DID,
    });
  }
  expect(invocations(attempts).length).toBeGreaterThanOrEqual(4);
  expect(attempts.filter((attempt) => new URL(attempt.url).pathname === "/delegate").length).toBe(2);
  expect(origins(attempts)).toEqual(new Set([TEE]));
});

const walletGrantRecipient = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(new Uint8Array(32).fill(5))]))}`;
const walletGrantActions = ["tinycloud.kv/get", "tinycloud.kv/list"];

// A session limited to one prefix: a grant outside it falls back to the wallet-signed path.
async function walletGrantOrigins(path: string): Promise<Set<string>> {
  const { node, attempts } = await fixture({ abilities: { kv: { "mine/": walletGrantActions } } });
  await node.createDelegation({ delegateDID: walletGrantRecipient, path, actions: walletGrantActions, includePublicSpace: false });
  const posted = attempts.filter((attempt) => new URL(attempt.url).pathname === "/delegate");
  expect(posted.length).toBeGreaterThan(0);
  return origins(posted);
}

test("a wallet-signed grant of the whole key space to another DID goes only to the TEE origin", async () => {
  expect(await walletGrantOrigins("")).toEqual(new Set([TEE]));
});

test("a self-hosted node keeps its own origin for vault traffic", async () => {
  const { node, attempts } = await fixture({ routedUrl: CUSTOM });
  await node.vault.list();
  expect(origins(attempts)).toEqual(new Set([CUSTOM]));
});
