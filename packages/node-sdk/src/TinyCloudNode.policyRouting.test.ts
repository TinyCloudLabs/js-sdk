import "../../operations/test-support/test-bootstrap.mjs";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58btc } from "multiformats/bases/base58";
import {
  canonicalizeEncryptionJson,
  pkhDid,
  signLocationRecordV2,
  importPortableDelegation,
  revokePolicyRootV3,
  registryOwnerKeyV2,
  signCompactUcanAuthorization,
  type LocationRecordV2Payload,
  type RegisterPolicyV3Input,
} from "@tinycloud/sdk-core";
import { TinyCloudNode } from "./TinyCloudNode";
import { NodeWasmBindings } from "./NodeWasmBindings";
import "./replication/node-loader";
import { createSqliteReplicaStorage } from "./replication/sqlite";
import { PrivateKeySigner } from "./signers/PrivateKeySigner";
import { PROOF_PRIVATE_KEY, signedRestorableSession } from "./test-support/signed-restorable-session";

const REGISTRY = "https://registry.test";
const STALE = "https://stale-node.test";
const ROUTED = "https://registered-node.test";
const SECOND = "https://second-node.test";
const seed = new Uint8Array(32).fill(7);
const NODE_DID = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...ed25519.getPublicKey(seed)]))}`;
const OTHER_DID = "did:key:z6MkjkxcrsuBXGxVYAZFC1hPUViiRXLC5Kup4G9aBkFoPimV";
const owner = new PrivateKeySigner(PROOF_PRIVATE_KEY);
const originalFetch = globalThis.fetch;
const nodes: TinyCloudNode[] = [];
const replicaRoots: string[] = [];

afterEach(async () => {
  try {
    for (const node of nodes.splice(0)) await node.replication?.close();
  } finally {
    globalThis.fetch = originalFetch;
    for (const root of replicaRoots.splice(0)) await rm(root, { recursive: true, force: true });
  }
});

type Attempt = { url: string; method: string; headers: Array<[string, string]>; authorization: string | null; hasBody: boolean; body: string | undefined; redirect: RequestRedirect | undefined };
type Proof = Awaited<ReturnType<typeof signedRestorableSession>>;

function registration(proof: Proof): Omit<RegisterPolicyV3Input, "nodeOrigin" | "fetch"> {
  return {
    policyCid: "bafy-policy",
    policy: { schema: "xyz.tinycloud.policy/policy/v2", policyId: "policy-routing-test", contentSource: { kvResource: `${proof.spaceId}/kv/route-probe` } },
    policyRoot: { cid: "bafy-policy-root", authorization: "TEST-policy-authorization" },
    enforcementRoot: { cid: "bafy-enforcement-root", authorization: "TEST-enforcement-authorization" },
    contentSourceDigestHex: "1".repeat(64), nativeProjectionHashHex: "2".repeat(64),
    rootExpiresAt: new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    enforcerDid: NODE_DID, expectedNodeAudience: NODE_DID,
  };
}

function delivery() {
  return {
    envelope: { version: 3 }, resourcePath: "route-probe", recipientEmail: "recipient@example.test",
    shareUrl: `https://share.tinycloud.xyz/s/lqdw5iopqq2tkkvjj6gbbi5vbv#v=4&k=${"A".repeat(43)}&c=bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u`,
    documentName: "routing-test.txt", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deliveryAudience: "https://credentials.test", idempotencyKey: "policy-routing-test",
  };
}

async function fixture(mode: "cold" | "registered" | "wrong-identity", options: {
  replication?: boolean; ambiguous?: boolean; accountRoute?: "routed" | "missing"; newUserHost?: string; publicSpace?: boolean;
} = {}) {
  const { replication = false, ambiguous = false, accountRoute } = options;
  const proof = await signedRestorableSession({
    abilities: {
      kv: { "": ["tinycloud.kv/get"] },
      delegation: { "": ["tinycloud.delegation/list", "tinycloud.delegation/status", "tinycloud.delegation/revoke"] },
      space: { "": ["tinycloud.space/host"] },
    },
    ...(accountRoute || options.publicSpace ? { ownedSpaceAbilities: {
      ...(accountRoute ? { account: {
        kv: { "": ["tinycloud.kv/get"] },
        delegation: { "": ["tinycloud.delegation/list", "tinycloud.delegation/revoke"] },
      } } : {}),
      ...(options.publicSpace ? { public: {
        kv: { "": ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"] },
      } } : {}),
    } } : {}),
  });
  const params = registration(proof);
  const payload: LocationRecordV2Payload = {
    version: 2, subject: pkhDid(proof.address, 1), nodes: [{ did: NODE_DID, url: ROUTED }, ...(ambiguous || accountRoute === "routed" ? [{ did: OTHER_DID, url: SECOND }] : [])],
    spaces: [
      { space: proof.spaceId.toLowerCase(), nodes: [{ did: NODE_DID, mode: "read-write" }, ...(ambiguous ? [{ did: OTHER_DID, mode: "read-write" as const }] : [])] },
      ...(accountRoute === "routed" ? [{ space: proof.spaces!.account!.toLowerCase(), nodes: [{ did: OTHER_DID, mode: "read-write" as const }] }] : []),
      ...(options.publicSpace ? [{ space: proof.spaces!.public!.toLowerCase(), nodes: [{ did: NODE_DID, mode: "read-write" as const }] }] : []),
    ],
    encryptionNode: NODE_DID, updated_at: "2026-10-18T00:00:00.000Z", sequence: 1,
  };
  const record = await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => owner.signMessage(message) });
  const records = new Map([[registryOwnerKeyV2(payload.subject).toLowerCase(), record]]);
  const registryFailures = new Map<string, number>();
  const responses = new Map<string, { status: number; body: string }>();
  const attempts: Attempt[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    attempts.push({ url: url.href, method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: [...headers.entries()], authorization: headers.get("authorization"),
      hasBody: init?.body != null || (input instanceof Request && input.body !== null),
      body: typeof init?.body === "string" ? init.body : undefined, redirect: init?.redirect });
    if (url.origin === REGISTRY) {
      const key = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1)).toLowerCase();
      const failure = mode === "cold" ? 503 : registryFailures.get(key);
      if (failure) return new Response("unavailable", { status: failure });
      const selected = records.get(key);
      return selected ? Response.json({ record: selected }) : Response.json({ error: "location record not found" }, { status: 404 });
    }
    if (url.origin !== STALE && url.origin !== ROUTED && url.origin !== SECOND) throw new Error(`Unexpected fixture origin ${url.origin}`);
    const identity = url.origin === STALE || url.origin === SECOND || mode === "wrong-identity" ? OTHER_DID : NODE_DID;
    if (url.pathname === "/info") return Response.json({ protocol: 1, version: "1.0.0", features: ["delegation-issued-query-v1"], nodeId: identity });
    if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json({ nodeDid: identity });
    if (url.pathname.startsWith("/peer/generate/")) return new Response(identity);
    const response = responses.get(url.href);
    if (response) return new Response(response.body, { status: response.status });
    if (url.pathname === "/policy/v3/enforcer-bindings") {
      const unsigned = {
        schema: "xyz.tinycloud.policy/attested-enforcer/v2", enforcerDid: NODE_DID, nodeAudience: NODE_DID,
        attestationBindingDigestHex: Buffer.from(sha256(new TextEncoder().encode(canonicalizeEncryptionJson({ enforcerDid: NODE_DID, nodeAudience: NODE_DID })))).toString("hex"),
        issuedAt: new Date().toISOString(), expiresAt: params.rootExpiresAt,
      };
      const signature = ed25519.sign(sha256(new TextEncoder().encode(`xyz.tinycloud.policy/AttestedEnforcerBinding/v2\0${canonicalizeEncryptionJson(unsigned)}`)), seed);
      return Response.json({ ...unsigned, signature: { suite: "Ed25519", signerDid: NODE_DID, value: Buffer.from(signature).toString("base64url") } });
    }
    if (url.pathname.startsWith("/policy/") || url.pathname.startsWith("/delegation/") || url.pathname === "/delegate" || url.pathname === "/revoke") return new Response("Denied by fixture", { status: 403 });
    throw new Error(`Unexpected fixture endpoint ${url.pathname}`);
  }) as typeof fetch;
  const profileDir = replication ? await mkdtemp(join(tmpdir(), "policy-preflight-")) : undefined;
  if (profileDir) replicaRoots.push(profileDir);
  const node = new TinyCloudNode({ signer: owner, wasmBindings: new NodeWasmBindings(), tinycloudRegistryUrl: REGISTRY,
    ...(options.newUserHost ? { newUserHost: options.newUserHost } : {}),
    autoDiscoverLocalNode: false, ...(profileDir ? { replication: { enabled: true, prefixes: ["notes/"],
      mode: "foreground" as const, profileDir,
      storage: createSqliteReplicaStorage({ dir: join(profileDir, "replicas"), guard: async (section) => section() }),
    } } : {}) });
  nodes.push(node);
  await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
  return { node, proof, params, attempts, records, registryFailures, responses };
}

for (const operation of ["registration", "delivery", "identity"] as const) {
  test(`cold registry refuses restored ${operation} before any configured-host request`, async () => {
    const { node, params, attempts } = await fixture("cold");
    expect(attempts).toEqual([]);
    const action = operation === "registration" ? node.registerPolicy(params)
      : operation === "delivery" ? node.authorizeShareDeliveryV3(delivery()) : node.activeNodeIdentity();
    await expect(action).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
    expect(attempts.every((attempt) => attempt.authorization === null && attempt.body === undefined)).toBe(true);
  });
}

for (const operation of ["registration", "delivery"] as const) {
  test(`registered ${operation} uses only the identity-checked route, never the saved host`, async () => {
    const { node, params, attempts } = await fixture("registered");
    const action = operation === "registration" ? node.registerPolicy(params) : node.authorizeShareDeliveryV3(delivery());
    await expect(action).rejects.toThrow("403");
    expect(attempts.some((attempt) => new URL(attempt.url).origin === STALE)).toBe(false);
    const endpoints = attempts.filter((attempt) => attempt.method === "POST");
    expect(endpoints.map((attempt) => attempt.url)).toEqual(operation === "registration"
      ? [`${ROUTED}/policy/v3/enforcer-bindings`, `${ROUTED}/policy/v3/policies`]
      : [`${ROUTED}/policy/v3/deliveries/authorize`]);
    const firstPost = attempts.findIndex((attempt) => attempt.method === "POST");
    expect(attempts.slice(0, firstPost).some((attempt) => attempt.url === `${ROUTED}/info`)).toBe(true);
    expect(attempts.slice(0, firstPost).some((attempt) => attempt.url === `${ROUTED}/.well-known/tinycloud/node-keys`)).toBe(true);
    expect(endpoints.every((attempt) => attempt.redirect === "error")).toBe(true);
    if (operation === "delivery") {
      const authorization = endpoints[0]!.authorization!;
      const token = authorization.replace(/^Bearer\s+/i, "");
      expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")).aud).toBe(NODE_DID);
    }
  });

  test(`wrong destination identity refuses ${operation} before any policy body or credential`, async () => {
    const { node, params, attempts } = await fixture("wrong-identity");
    const action = operation === "registration" ? node.registerPolicy(params) : node.authorizeShareDeliveryV3(delivery());
    await expect(action).rejects.toMatchObject({ code: "NODE_IDENTITY_MISMATCH" });
    expect(attempts.some((attempt) => attempt.method !== "GET")).toBe(false);
    expect(attempts.every((attempt) => attempt.authorization === null && attempt.body === undefined)).toBe(true);
  });
}

test("active identity describes the resolved origin and public identity, not the saved host", async () => {
  const { node, attempts } = await fixture("registered");
  expect(await node.activeNodeIdentity()).toEqual({ origin: ROUTED, nodeDid: NODE_DID });
  expect(attempts.some((attempt) => new URL(attempt.url).origin === STALE)).toBe(false);
});

test("the offline replication hint preflight sends no credential, body or secret bytes", async () => {
  const { attempts } = await fixture("cold", { replication: true });
  const hint = attempts.filter((attempt) => new URL(attempt.url).origin === STALE);
  expect(hint.map((attempt) => [attempt.method, attempt.url])).toEqual([["GET", `${STALE}/info`]]);
  expect(hint.map(({ headers, hasBody, body, authorization }) => ({ headers, hasBody, body, authorization })))
    .toEqual([{ headers: [], hasBody: false, body: undefined, authorization: null }]);
  expect(hint.every((attempt) => !attempt.url.includes("#") && !attempt.url.includes("?"))).toBe(true);
});

for (const operation of ["host", "ensure"] as const) {
  test(`existing ${operation} hosting guard refuses cold routing before signed activation`, async () => {
    const { node, attempts } = await fixture("cold");
    const action = operation === "host" ? node.hostOwnedSpace("default") : node.ensureOwnedSpaceHosted("default");
    await expect(action).rejects.toMatchObject({ code: "registry_unavailable" });
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
  });

  test(`existing ${operation} hosting uses the registered destination before activation`, async () => {
    const { node, attempts } = await fixture("registered");
    const action = operation === "host" ? node.hostOwnedSpace("default") : node.ensureOwnedSpaceHosted("default");
    await expect(action).rejects.toThrow();
    const posts = attempts.filter((attempt) => attempt.method === "POST");
    expect(posts.map((attempt) => attempt.url)).toEqual([`${ROUTED}/delegate`]);
    expect(attempts.some((attempt) => new URL(attempt.url).origin === STALE)).toBe(false);
  });
}

function delegationRequest(node: TinyCloudNode, proof: Proof, operation: "revoke" | "status" | "received-query" | "issued-query") {
  switch (operation) {
    case "revoke": return node.delegationManager.revoke(proof.delegationCid);
    case "status": return node.delegationManager.status(proof.delegationCid);
    case "received-query": return node.delegationManager.query({ direction: "received" }, { spaces: [proof.spaceId] });
    case "issued-query": return node.delegationManager.query({ direction: "issued" });
  }
}

for (const operation of ["revoke", "status", "received-query", "issued-query"] as const) {
  test(`audit ${operation} does not send a configured-host credential during cold routing`, async () => {
    const { node, proof, attempts } = await fixture("cold");
    expect((await delegationRequest(node, proof, operation)).ok).toBe(false);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
  });

  test(`audit ${operation} sends only to the identity-checked registry destination`, async () => {
    const { node, proof, attempts } = await fixture("registered");
    expect((await delegationRequest(node, proof, operation)).ok).toBe(false);
    const posts = attempts.filter((attempt) => attempt.method === "POST");
    const endpoint = operation === "revoke" ? "/revoke" : operation === "status" ? "/delegation/status" : "/delegation/query";
    expect(posts.map((attempt) => attempt.url)).toEqual([`${ROUTED}${endpoint}`]);
    expect(attempts.some((attempt) => new URL(attempt.url).origin === STALE)).toBe(false);
    const firstPost = attempts.findIndex((attempt) => attempt.method === "POST");
    expect(attempts.slice(0, firstPost).some((attempt) => attempt.url === `${ROUTED}/info`)).toBe(true);
    expect(attempts.slice(0, firstPost).some((attempt) => attempt.url === `${ROUTED}/.well-known/tinycloud/node-keys`)).toBe(true);
  });
}

test("the issued-query signer chooses its audience from the current registered identity", async () => {
  const { node, proof, attempts } = await fixture("registered");
  expect((await delegationRequest(node, proof, "issued-query")).ok).toBe(false);
  const sent = attempts.find((attempt) => new URL(attempt.url).pathname === "/delegation/query" && attempt.method === "POST");
  expect(sent?.authorization).toBeDefined();
  const token = sent!.authorization!.replace(/^Bearer\s+/i, "");
  expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")).aud).toBe(NODE_DID);
});

function shareGrant(proof: Proof, path = "route-probe") {
  const wasm = new NodeWasmBindings();
  const manager = wasm.createSessionManager();
  manager.createSessionKey("share");
  manager.createSessionKey("recipient");
  const keyDid = manager.getDID("share").split("#", 1)[0]!;
  const recipientDid = manager.getDID("recipient").split("#", 1)[0]!;
  const key = JSON.parse(manager.jwk("share")!);
  const result = wasm.createDelegation({
    delegationHeader: proof.delegationHeader, delegationCid: proof.delegationCid,
    spaceId: proof.spaceId, verificationMethod: proof.verificationMethod.split("#", 1)[0]!, jwk: proof.jwk,
  }, keyDid, proof.spaceId, { kv: { [path]: ["tinycloud.kv/get"] } },
  Math.floor(Date.now() / 1000) + 60, Math.floor(Date.now() / 1000) - 1);
  const delegation = {
    cid: result.cid, delegationHeader: { Authorization: result.delegation },
    ownerAddress: proof.address, chainId: proof.chainId, host: STALE, spaceId: proof.spaceId,
    path, actions: ["tinycloud.kv/get"], expiry: new Date(result.expiry * 1000),
    delegateDID: keyDid, delegatorDID: proof.verificationMethod.split("#", 1)[0]!,
    parentCid: proof.delegationCid, resources: result.resources,
  };
  return { delegation, key, keyDid, recipientDid };
}

function receivedShareLink(node: TinyCloudNode, grant: ReturnType<typeof shareGrant>, spaceId = grant.delegation.spaceId) {
  return node.sharing.encodeLink({
    version: 1, host: STALE, spaceId, path: grant.delegation.path, keyDid: grant.keyDid, key: grant.key,
    delegation: {
      cid: grant.delegation.cid, delegateDID: grant.keyDid, delegatorDID: grant.delegation.delegatorDID,
      spaceId, path: grant.delegation.path, actions: ["tinycloud.kv/get"],
      expiry: grant.delegation.expiry, isRevoked: false, allowSubDelegation: true,
      authHeader: grant.delegation.delegationHeader.Authorization,
    },
  });
}

async function addedRequest(node: TinyCloudNode, proof: Proof, operation: "issued-revoke" | "space-revoke" | "portable" | "root-revoke" | "generated-share" | "received-share") {
  if (operation === "issued-revoke") return node.delegationManager.revokeIssued(proof.delegationCid);
  if (operation === "space-revoke") return node.spaces.get(proof.spaceId).delegations.revoke(proof.delegationCid);
  if (operation === "root-revoke") return revokePolicyRootV3({
    nodeOrigin: STALE, rootCid: proof.delegationCid, targetRole: "policy-enforcement",
    ownerDid: node.credentialHolderDid, issuerDid: node.credentialHolderDid, nodeAudience: NODE_DID,
    reason: "TEST revocation", sign: (bytes) => node.signSessionBytes(bytes),
    spaceId: proof.spaceId, resourceTransport: node.resourceTransport,
  });
  if (operation === "generated-share") return node.sharing.generate({
    path: "route-probe", actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + 45_000), allowSubDelegation: true,
  });
  const grant = shareGrant(proof);
  if (operation === "portable") return importPortableDelegation(globalThis.fetch, STALE, grant.delegation, node.resourceTransport);
  const link = receivedShareLink(node, grant);
  return node.sharing.delegateReceivedShare(link, {
    delegateDID: grant.recipientDid, path: "route-probe", actions: ["tinycloud.kv/get"],
    expiry: new Date(Date.now() + 30_000),
  });
}

for (const operation of ["issued-revoke", "space-revoke", "portable", "root-revoke", "generated-share", "received-share"] as const) {
  test(`additional ${operation} refuses cold routing before any configured-host credential`, async () => {
    const { node, proof, attempts } = await fixture("cold");
    await addedRequest(node, proof, operation).catch(() => undefined);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
  });

  test(`additional ${operation} sends only to its checked registry destination`, async () => {
    const { node, proof, attempts } = await fixture("registered");
    await addedRequest(node, proof, operation).catch(() => undefined);
    const posts = attempts.filter((attempt) => attempt.method === "POST");
    const endpoint = operation === "issued-revoke" || operation === "space-revoke" || operation === "root-revoke" ? "/revoke" : "/delegate";
    expect(posts.map((attempt) => attempt.url)).toEqual([`${ROUTED}${endpoint}`]);
    expect(attempts.some((attempt) => new URL(attempt.url).origin === STALE)).toBe(false);
    const firstPost = attempts.findIndex((attempt) => attempt.method === "POST");
    expect(attempts.slice(0, firstPost).some((attempt) => attempt.url === `${ROUTED}/info`)).toBe(true);
    expect(attempts.slice(0, firstPost).some((attempt) => attempt.url === `${ROUTED}/.well-known/tinycloud/node-keys`)).toBe(true);
  });
}

for (const operation of ["revoke", "status", "issued-query"] as const) {
  test(`ambiguous node-local ${operation} refuses instead of choosing a control destination`, async () => {
    const { node, proof, attempts } = await fixture("registered", { ambiguous: true });
    expect((await delegationRequest(node, proof, operation)).ok).toBe(false);
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
  });
}

test("portable metadata cannot replace the signed grant's routing space", async () => {
  const { node, proof, attempts } = await fixture("registered");
  const grant = shareGrant(proof);
  const wrongSpace = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:default";
  await importPortableDelegation(globalThis.fetch, STALE, {
    ...grant.delegation, spaceId: wrongSpace,
    resources: [{ service: "kv", space: wrongSpace, path: "route-probe", actions: ["tinycloud.kv/get"] }],
  }, node.resourceTransport).catch(() => undefined);
  const posts = attempts.filter((attempt) => attempt.method === "POST");
  expect(posts.map((attempt) => attempt.url)).toEqual([`${ROUTED}/delegate`]);
  expect(posts[0]!.authorization).toBe(grant.delegation.delegationHeader.Authorization);
});

test("received-share metadata cannot replace the cryptographically signed parent space", async () => {
  const { node, proof, attempts } = await fixture("registered");
  const grant = shareGrant(proof);
  const link = receivedShareLink(node, grant, "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000002:default");
  const result = await node.sharing.delegateReceivedShare(link, {
    delegateDID: grant.recipientDid, path: "route-probe", actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + 30_000),
  });
  expect(result.ok).toBe(false);
  expect(attempts).toEqual([]);
});

test("received-share transport uses the verified sharer instead of the receiving session", async () => {
  const { node, attempts, records } = await fixture("registered");
  const privateKey = "1".repeat(64);
  const sharer = new PrivateKeySigner(privateKey);
  const foreign = await signedRestorableSession({ privateKey });
  const payload: LocationRecordV2Payload = {
    version: 2, subject: pkhDid(foreign.address, 1), nodes: [{ did: OTHER_DID, url: SECOND }],
    spaces: [{ space: foreign.spaceId.toLowerCase(), nodes: [{ did: OTHER_DID, mode: "read-write" }] }],
    encryptionNode: OTHER_DID, updated_at: "2026-10-18T00:00:00.000Z", sequence: 1,
  };
  records.set(registryOwnerKeyV2(payload.subject).toLowerCase(),
    await signLocationRecordV2(payload, { type: "did:pkh", signMessage: (message) => sharer.signMessage(message) }));
  const grant = shareGrant(foreign);
  await node.sharing.delegateReceivedShare(receivedShareLink(node, grant), {
    delegateDID: grant.recipientDid, path: "route-probe", actions: ["tinycloud.kv/get"], expiry: new Date(Date.now() + 30_000),
  });
  expect(attempts.filter((attempt) => attempt.method === "POST").map((attempt) => attempt.url)).toEqual([`${SECOND}/delegate`]);
  expect(attempts.some((attempt) => attempt.url === `${SECOND}/.well-known/tinycloud/node-keys`)).toBe(true);
});

test("explicit-space revocation keeps every writable target and reports partial completion", async () => {
  const { node, proof, attempts, responses } = await fixture("registered", { ambiguous: true });
  responses.set(`${ROUTED}/revoke`, { status: 200, body: "" });
  const result = await node.spaces.get(proof.spaceId).delegations.revoke(proof.delegationCid);
  expect(attempts.filter((attempt) => attempt.method === "POST").map((attempt) => attempt.url)).toEqual([`${ROUTED}/revoke`, `${SECOND}/revoke`]);
  expect(result).toMatchObject({ ok: false, error: { code: "PARTIAL_NODE_WRITE", meta: { succeeded: [ROUTED], failed: [{ url: SECOND, status: 403 }] } } });
});

test("received queries resolve each authorized space independently", async () => {
  const { node, proof, attempts } = await fixture("registered", { accountRoute: "routed" });
  const result = await node.delegationManager.query({}, { spaces: [proof.spaces!.account!, proof.spaceId] });
  expect(result.ok).toBe(false);
  const posts = attempts.filter((attempt) => attempt.method === "POST");
  expect(posts.map((attempt) => attempt.url)).toEqual([`${SECOND}/delegation/query`, `${ROUTED}/delegation/query`]);
  expect(posts.map((attempt) => JSON.parse(Buffer.from(attempt.authorization!.split(".")[1]!, "base64url").toString()).aud)).toEqual([OTHER_DID, NODE_DID]);
});

test("a registry refusal is not permission to try the next received-query scope", async () => {
  const { node, proof, attempts } = await fixture("registered", { accountRoute: "missing" });
  const result = await node.delegationManager.query({}, { spaces: [proof.spaces!.account!, proof.spaceId] });
  expect(result.ok).toBe(false);
  expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
  expect(attempts.some((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
});

test("an identity decision retired during registry lookup does not contact a node", async () => {
  const { node, proof, attempts } = await fixture("registered");
  const fetchFn = globalThis.fetch;
  let release!: () => void;
  let started!: () => void;
  let held = false;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const lookupStarted = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = (async (input, init) => {
    const response = await fetchFn(input, init);
    if (!held && new URL(input instanceof Request ? input.url : String(input)).origin === REGISTRY) {
      held = true;
      started();
      await blocked;
    }
    return response;
  }) as typeof fetch;
  const pending = node.activeNodeIdentity().then(() => undefined, (error: unknown) => error);
  try {
    await lookupStarted;
    await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
  } finally {
    release();
  }
  expect(await pending).toBeInstanceOf(Error);
  expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
});

test("retiring a graph between policy steps prevents the root-bearing POST", async () => {
  const { node, proof, params, attempts } = await fixture("registered");
  const fetchFn = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const response = await fetchFn(input, init);
    if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/policy/v3/enforcer-bindings") {
      await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
    }
    return response;
  }) as typeof fetch;
  await node.registerPolicy(params).catch(() => undefined);
  expect(attempts.filter((attempt) => attempt.method === "POST").map((attempt) => new URL(attempt.url).pathname))
    .toEqual(["/policy/v3/enforcer-bindings"]);
});

test("a retained delegation manager cannot send through a replacement graph", async () => {
  const { node, proof, attempts } = await fixture("registered");
  const oldManager = node.delegationManager;
  await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
  expect((await oldManager.status(proof.delegationCid)).ok).toBe(false);
  expect(attempts).toEqual([]);
});

async function twoSpaceGrant(proof: Proof) {
  const grant = shareGrant(proof);
  const spaces = [proof.spaceId, proof.spaces!.account!];
  const now = Math.floor(Date.now() / 1000);
  const signed = await signCompactUcanAuthorization({
    issuerDid: proof.verificationMethod.split("#", 1)[0]!, audienceDid: grant.keyDid,
    attenuation: Object.fromEntries(spaces.map((space) => [`${space}/kv/route-probe`, { "tinycloud.kv/get": [{}] }])),
    facts: [{}], proofs: [proof.delegationCid], notBefore: now - 1, expiresAt: now + 59,
    nonce: `urn:uuid:${crypto.randomUUID()}`,
    sign: (bytes) => ed25519.sign(bytes, Buffer.from((proof.jwk as { d: string }).d, "base64url")),
  });
  return {
    ...grant.delegation, cid: signed.cid, delegationHeader: { Authorization: signed.authorization },
    expiry: new Date((now + 59) * 1000),
    resources: spaces.map((space) => ({ service: "kv", space, path: "route-probe", actions: ["tinycloud.kv/get"] })),
  };
}

test("portable activation resolves all signed spaces and combines real node receipts", async () => {
  const { node, proof, attempts, responses } = await fixture("registered", { accountRoute: "routed" });
  responses.set(`${ROUTED}/delegate`, { status: 200, body: JSON.stringify({ activated: [proof.spaceId], skipped: [proof.spaces!.account!] }) });
  responses.set(`${SECOND}/delegate`, { status: 200, body: JSON.stringify({ activated: [proof.spaces!.account!], skipped: [proof.spaceId] }) });
  const receipt = await importPortableDelegation(globalThis.fetch, STALE, await twoSpaceGrant(proof), node.resourceTransport);
  expect(attempts.filter((attempt) => attempt.method === "POST").map((attempt) => attempt.url).sort())
    .toEqual([`${ROUTED}/delegate`, `${SECOND}/delegate`].sort());
  expect([...receipt.activated!].sort()).toEqual([proof.spaceId, proof.spaces!.account!].sort());
  expect(receipt.skipped).toEqual([]);
});

test("an unrouted signed portable space refuses before any grant is sent", async () => {
  const { node, proof, attempts } = await fixture("registered", { accountRoute: "missing" });
  await importPortableDelegation(globalThis.fetch, STALE, await twoSpaceGrant(proof), node.resourceTransport).catch(() => undefined);
  expect(attempts.some((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
  expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
});

for (const mode of ["cold", "registered"] as const) {
  test(`received data ${mode} uses only the verified share actor and current route`, async () => {
    const { node, proof, attempts, responses } = await fixture(mode);
    const grant = shareGrant(proof, "notes/");
    responses.set(`${ROUTED}/invoke`, { status: 403, body: "Denied by fixture" });
    const received = await node.sharing.receive(receivedShareLink(node, grant), { autoSubdelegate: false });
    expect(received.ok).toBe(true);
    if (!received.ok) throw new Error("Expected a locally valid sharing link");
    const result = await received.data.kv.get("item");
    expect(result.ok).toBe(false);
    if (mode === "cold") {
      expect(attempts.some((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
      expect(attempts.every((attempt) => new URL(attempt.url).origin === REGISTRY)).toBe(true);
    } else {
      const posts = attempts.filter((attempt) => attempt.method === "POST");
      expect(posts.map((attempt) => attempt.url)).toEqual([`${ROUTED}/invoke`]);
      const payload = JSON.parse(Buffer.from(posts[0]!.authorization!.split(".")[1]!, "base64url").toString());
      expect(payload.iss.split("#", 1)[0]).toBe(grant.keyDid);
      expect(payload.aud).toBe(NODE_DID);
      expect(payload.prf).toEqual([grant.delegation.cid]);
    }
  });
}

test("owner-qualified policy URIs retain their signed resource scope", async () => {
  const { node, proof, params, attempts } = await fixture("registered");
  await node.registerPolicy({ ...params, policy: {
    ...params.policy, contentSource: { kvResource: `tinycloud://${proof.spaceId}/kv/route-probe` },
  } }).catch(() => undefined);
  expect(attempts.filter((attempt) => attempt.method === "POST").map((attempt) => attempt.url))
    .toEqual([`${ROUTED}/policy/v3/enforcer-bindings`, `${ROUTED}/policy/v3/policies`]);
});

test("a node-local policy name cannot borrow the receiving account as routing owner", async () => {
  const { node, params, attempts } = await fixture("registered");
  await expect(node.registerPolicy({ ...params, policy: {
    ...params.policy, contentSource: { kvResource: "tinycloud://applications/kv/route-probe" },
  } })).rejects.toMatchObject({ code: "RESOURCE_NOT_ROUTED" });
  expect(attempts).toEqual([]);
});

test("authoritative absence uses trusted new-user configuration, never a restored host", async () => {
  const { node, attempts, records } = await fixture("registered", { newUserHost: ROUTED });
  records.clear();
  await node.authorizeShareDeliveryV3(delivery()).catch(() => undefined);
  expect(attempts.filter(({ method }) => method === "POST").map(({ url }) => url))
    .toEqual([`${ROUTED}/policy/v3/deliveries/authorize`]);
  expect(attempts.some(({ url }) => new URL(url).origin === STALE)).toBe(false);
});

test("issued activation cannot promote a saved host when registration is authoritatively absent", async () => {
  const { node, attempts, records } = await fixture("registered", { newUserHost: ROUTED });
  records.clear();
  await node.delegateTo(OTHER_DID, [{
    service: "tinycloud.kv", space: "default", path: "route-probe", actions: ["tinycloud.kv/get"],
  }]).catch(() => undefined);
  expect(attempts.filter(({ method }) => method === "POST").map(({ url }) => url))
    .toEqual([`${ROUTED}/delegate`]);
  expect(attempts.some(({ url }) => new URL(url).origin === STALE)).toBe(false);
});

test("replacing the graph in an issued grant's prepared hook prevents activation", async () => {
  const { node, proof, attempts } = await fixture("registered");
  await node.delegateTo(OTHER_DID, [{
    service: "tinycloud.kv", space: "default", path: "route-probe", actions: ["tinycloud.kv/get"],
  }], {
    onPrepared: () => node.restoreSession({ ...proof, tinycloudHosts: [STALE] }),
  }).catch(() => undefined);
  expect(attempts.map(({ method, url }) => ({ method, url }))).toEqual([]);
});

test("retiring an issued graph during destination verification sends no activation credential", async () => {
  const { node, proof, attempts } = await fixture("registered");
  const fetchFn = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const response = await fetchFn(input, init);
    if (new URL(input instanceof Request ? input.url : String(input)).href === `${ROUTED}/.well-known/tinycloud/node-keys`) {
      await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
    }
    return response;
  }) as typeof fetch;
  await node.delegateTo(OTHER_DID, [{
    service: "tinycloud.kv", space: "default", path: "route-probe", actions: ["tinycloud.kv/get"],
  }]).catch(() => undefined);
  expect(attempts.some(({ url }) => url === `${ROUTED}/.well-known/tinycloud/node-keys`)).toBe(true);
  expect(attempts.filter(({ authorization }) => authorization !== null).map(({ method, url }) => ({ method, url }))).toEqual([]);
});

for (const operation of ["wallet-delegation", "wallet-subdelegation"] as const) {
  test(`retiring the graph while signing ${operation} sends no activation credential`, async () => {
    const { node, proof, attempts } = await fixture("registered");
    const grant = shareGrant(proof);
    const sign = owner.signMessage;
    let signed = false;
    owner.signMessage = async (message) => {
      const signature = await sign.call(owner, message);
      signed = true;
      await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
      return signature;
    };
    try {
      if (operation === "wallet-delegation") {
        await node.delegateTo(OTHER_DID, [{
          service: "tinycloud.kv", space: "default", path: "route-probe", actions: ["tinycloud.kv/get"],
        }], { forceWalletSign: true }).catch(() => undefined);
      } else {
        await node.createSubDelegation(grant.delegation, {
          path: "route-probe", actions: ["tinycloud.kv/get"], delegateDID: OTHER_DID,
        }).catch(() => undefined);
      }
    } finally {
      owner.signMessage = sign;
    }
    expect(signed).toBe(true);
    expect(attempts.filter(({ authorization }) => authorization !== null).map(({ method, url }) => ({ method, url }))).toEqual([]);
  });
}

test("public-space hosting never promotes a restored host after canonical registration absence", async () => {
  const { node, proof, attempts, records, responses } = await fixture("registered", { newUserHost: ROUTED, publicSpace: true });
  records.clear();
  const receipt = JSON.stringify({ activated: [proof.spaceId, proof.spaces!.public!], skipped: [] });
  responses.set(`${ROUTED}/delegate`, { status: 200, body: receipt });
  responses.set(`${STALE}/delegate`, { status: 200, body: receipt });
  await node.ensurePublicSpace();
  expect(attempts.filter(({ method }) => method === "POST").map(({ url }) => url))
    .toEqual([`${ROUTED}/delegate`, `${ROUTED}/delegate`]);
  expect(attempts.some(({ url }) => new URL(url).origin === STALE)).toBe(false);
});

test("retiring the public-space graph during identity verification sends no hosting credential", async () => {
  const { node, proof, attempts, responses } = await fixture("registered", { publicSpace: true });
  responses.set(`${ROUTED}/delegate`, { status: 200, body: JSON.stringify({ activated: [proof.spaceId, proof.spaces!.public!], skipped: [] }) });
  const fetchFn = globalThis.fetch;
  let replaced = false;
  globalThis.fetch = (async (input, init) => {
    const response = await fetchFn(input, init);
    if (!replaced && new URL(input instanceof Request ? input.url : String(input)).href === `${ROUTED}/.well-known/tinycloud/node-keys`) {
      replaced = true;
      await node.restoreSession({ ...proof, tinycloudHosts: [STALE] });
    }
    return response;
  }) as typeof fetch;
  await node.ensurePublicSpace().catch(() => undefined);
  expect(replaced).toBe(true);
  expect(attempts.filter(({ authorization }) => authorization !== null).map(({ method, url }) => ({ method, url }))).toEqual([]);
});
