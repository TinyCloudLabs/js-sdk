import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { buildShortLink, prepareLinkRecord, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC2212-approval-test-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
Object.assign(process.env, fixtureEnvironment);
// Import without touching a real profile, then restore the importing process immediately.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson, writeJsonDurable } = await import("../config/storage.js");
const { readProfileSnapshot, commitLogin } = await import("./login-commit.js");
const { acquireApprovalRequest, completeApprovalResult } = await import("./approval-request.js");
const { verifyScopedLogin } = await import("./scoped-login.js");
const { relayPublicJwkOf } = await import("./device-auth.js");
const { createECDH } = await import("node:crypto");
restoreEnvironment(original);
let caseEnvironment = original;
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const wallet = new PrivateKeySigner(randomBytes(32).toString("hex"));
const address = await wallet.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const host = "https://node.example";
const spaceId = wasm.makeSpaceId(address, 1, "applications");
const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }];
const requestId = "abcdefghijklmnopqrstuvwxyz";
const resultRef = "synthetic-result-reference-123456";
let acknowledgements = new Map<string, string>();
let dropAck = false;
let savedBeforeAck = false;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { requestId: string; bodyCid: string; ackId: string };
  const pending = await readJson<Array<{ committed?: boolean; ackId: string; bodyCid: string }>>(join(profilePath("approval"), "approval-pending.json"));
  const session = await ProfileManager.getSession("approval") as Record<string, unknown> | null;
  savedBeforeAck = pending?.[0]?.committed === true && pending[0].ackId === body.ackId && session?.signature !== undefined;
  const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
  if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) return new Response(null, { status: 401 });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const credential = JSON.stringify(["ack", requestId, body.bodyCid, resultRef, body.ackId]);
  if (claims.htu !== request.url || claims.htm !== "POST" || claims.client_id !== "openkey-approval-result-v1" ||
    claims.cred_hash !== createHash("sha256").update(credential).digest("base64url")) return new Response(null, { status: 401 });
  const prior = acknowledgements.get(resultRef);
  if (prior && prior !== body.ackId) return new Response(null, { status: 409 });
  acknowledgements.set(resultRef, body.ackId);
  if (dropAck) { dropAck = false; return new Response("interrupted JSON"); }
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
} });

async function signedDelegation(actions = ["tinycloud.kv/list"]) {
  const prepared = wasm.prepareSession({ abilities: { kv: { "": actions } }, address, chainId: 1,
    domain: "cli.example", spaceId, jwk: key, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + 3600_000).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
}

async function stage(delegation: Record<string, unknown>, options: { expectedOwner?: string } = { expectedOwner: ownerDid }) {
  const relay = createECDH("prime256v1"); relay.generateKeys();
  const recipientJwk = relayPublicJwkOf(relay);
  const request = { issuer: did, requestVersion: 1 as const, targetDid: did,
    targetPublicJwk: { kty: key.kty, crv: key.crv, x: key.x }, nodeOrigin: host, permissions: requested,
    grantLifetimeSeconds: 3600, resultEncryptionPublicJwk: recipientJwk };
  const prepared = await prepareLinkRecord({ type: "openkey-approval-request", plaintext: new TextEncoder().encode(JSON.stringify(request)),
    issuerKey: signerFromJwk(key), apiOrigin: "https://api.tinycloud.xyz", expiresAt: new Date(Date.now() + 3600_000) });
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([
    Buffer.from([4]), Buffer.from(recipientJwk.x, "base64url"), Buffer.from(recipientJwk.y, "base64url"),
  ]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const delegationExpiresAt = new Date((delegation.siwe as string).match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
  const plaintext = { resultVersion: 1, requestId, requestDigest: prepared.bodyCid, requesterDid: did,
    ownerDid, targetDid: did, delegationExpiresAt, delegation };
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag(),
  ]);
  const resultEnvelope = { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral),
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  const entry = { version: 1, request, requestId, bodyCid: prepared.bodyCid,
    approvalUrl: buildShortLink({ origin: "https://openkey.example", type: "openkey-approval-request", id: requestId, key: prepared.key, bodyCid: prepared.bodyCid }),
    requestExpiresAt: prepared.record.header.expiresAt, record: prepared.record, apiOrigin: server.url.origin,
    linkApiOrigin: "https://api.tinycloud.xyz", openkeyOrigin: "https://openkey.example", signingKey: key,
    relayPrivateKey: relay.getPrivateKey().toString("base64url"), expectedOwner: options.expectedOwner, resultRef,
    resultExpiresAt: new Date(Date.now() + 600_000).toISOString(), resultEnvelope, ackId: "synthetic-durable-ack-123456789" };
  await writeJsonDurable(join(profilePath("approval"), "approval-pending.json"), [entry]);
  return entry;
}

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment);
  acknowledgements = new Map(); dropAck = false; savedBeforeAck = false;
  await rm(join(profilePath("approval"), "approval-pending.json"), { force: true });
  await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey("approval", key);
  await ProfileManager.clearSession("approval");
});
afterEach(async () => {
  try {
    await rm(join(profilePath("approval"), "approval-pending.json"), { force: true });
  } finally {
    restoreEnvironment(caseEnvironment);
  }
});
afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

test("a fetched approval is not acknowledged before durable login persistence", async () => {
  const delegation = await signedDelegation();
  const pending = await stage(delegation);
  await completeApprovalResult("approval");
  expect(acknowledgements.has(resultRef)).toBe(false);
  const snapshot = await readProfileSnapshot("approval");
  const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
  await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
  dropAck = true;
  await expect(completeApprovalResult("approval")).rejects.toBeDefined();
  expect(savedBeforeAck).toBe(true);
  expect(acknowledgements.get(resultRef)).toBe(pending.ackId);
  const durable = await readJson<Array<{ committed?: boolean; ackId: string }>>(join(profilePath("approval"), "approval-pending.json"));
  expect(durable?.[0]).toMatchObject({ committed: true, ackId: pending.ackId });
  await completeApprovalResult("approval");
  expect(acknowledgements.get(resultRef)).toBe(pending.ackId);
  expect(await readJson(join(profilePath("approval"), "approval-pending.json"))).toEqual([]);
});

test.each([ownerDid, undefined])("a saved result resumes with owner-qualified spaces without another approval (%s)", async (expectedOwner) => {
  const delegation = await signedDelegation();
  const pending = await stage(delegation, { expectedOwner });
  const snapshot = await readProfileSnapshot("approval");
  const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
  await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
  dropAck = true;
  await expect(completeApprovalResult("approval")).rejects.toBeDefined();
  let approvalRequests = 0;
  const send = globalThis.fetch;
  const localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== server.url.origin) throw new Error("A resumed result must not create a new request");
    return send(input, init);
  }, { preconnect: send.preconnect }));
  try {
    const recovered = await acquireApprovalRequest(did, {
      profileName: "approval", jwk: key, host, permissions: requested.map((permission) => ({ ...permission, space: spaceId })),
      expectedOwner: ownerDid, expiry: "1h", openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin,
      noPopup: true, onApprovalRequest: () => { approvalRequests++; },
    });
    expect(recovered.delegationCid).toBe(delegation.delegationCid);
    await completeApprovalResult("approval", recovered);
    expect(approvalRequests).toBe(0);
    expect(acknowledgements.get(resultRef)).toBe(pending.ackId);
    expect(await readJson(join(profilePath("approval"), "approval-pending.json"))).toEqual([]);
  } finally {
    localOnly.mockRestore();
  }
});

test.each(["signature", "owner", "key", "permission"])("ACK recovery revalidates %s before accepting persisted evidence", async (mutation) => {
  const valid = await signedDelegation();
  const invalid: Record<string, unknown> = { ...valid };
  if (mutation === "signature") invalid.signature = `0x${"11".repeat(65)}`;
  if (mutation === "owner") invalid.address = `0x${"11".repeat(20)}`;
  if (mutation === "key") invalid.verificationMethod = "did:key:unrelated";
  if (mutation === "permission") Object.assign(invalid, await signedDelegation(["tinycloud.kv/get"]));
  await stage(invalid);
  await expect(completeApprovalResult("approval")).rejects.toBeDefined();
  expect(acknowledgements.has(resultRef)).toBe(false);
  expect(await ProfileManager.getSession("approval")).toBeNull();
});
