import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { buildShortLink, checkLinkRecord, prepareLinkRecord, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

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
const { acquireApprovalRequest, completeApprovalResult, pendingApprovalKey } = await import("./approval-request.js");
const { verifyScopedLogin } = await import("./scoped-login.js");
const { clearProfileCredentials } = await import("../lib/logout-pending.js");
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
let terminalAckCode: string | undefined;
let terminalAck: { requestId: string; bodyCid: string; ackId: string } | undefined;
let retainedResultExpiresAt: string | undefined;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname === "/v1/links") {
    const checked = await checkLinkRecord(await request.json(), Date.now());
    if (checked.header.issuer !== did || checked.header.audience !== "https://api.tinycloud.xyz") return new Response(null, { status: 401 });
    const id = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    return Response.json({ id, expiresAt: checked.header.expiresAt }, { status: 201 });
  }
  const body = await request.json() as { requestId: string; bodyCid: string; ackId: string };
  const pending = await readJson<Array<{ committed?: boolean; ackId: string; bodyCid: string; resultEnvelope: unknown; resultExpiresAt: string }>>(join(profilePath("approval"), "approval-pending.json"));
  const session = await ProfileManager.getSession("approval") as Record<string, unknown> | null;
  savedBeforeAck = pending?.[0]?.committed === true && pending[0].ackId === body.ackId && session?.signature !== undefined;
  const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
  if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) return new Response(null, { status: 401 });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const action = new URL(request.url).pathname.endsWith("/result") ? "discover"
    : new URL(request.url).pathname.endsWith("/fetch") ? "fetch" : "ack";
  const credential = JSON.stringify([action, requestId, body.bodyCid, action === "discover" ? "" : resultRef, action === "ack" ? body.ackId : ""]);
  if (claims.htu !== request.url || claims.htm !== "POST" || claims.client_id !== "openkey-approval-result-v1" ||
    claims.cred_hash !== createHash("sha256").update(credential).digest("base64url")) return new Response(null, { status: 401 });
  if (action === "discover") return Response.json({ resultRef, expiresAt: pending![0]!.resultExpiresAt ?? retainedResultExpiresAt });
  if (action === "fetch") return Response.json({
    requestId, bodyCid: body.bodyCid, resultRef, expiresAt: pending![0]!.resultExpiresAt ?? retainedResultExpiresAt,
    relay: await readJson(join(profilePath("approval"), "retained-result.json")) ?? pending![0]!.resultEnvelope,
  });
  if (terminalAckCode) {
    terminalAck = body;
    return Response.json({ code: terminalAckCode }, { status: terminalAckCode === "not_found" ? 404 : 410 });
  }
  const prior = acknowledgements.get(resultRef);
  if (prior && prior !== body.ackId) return new Response(null, { status: 409 });
  acknowledgements.set(resultRef, body.ackId);
  if (dropAck) { dropAck = false; return new Response("interrupted JSON"); }
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
} });

async function signedDelegation(actions = ["tinycloud.kv/list"], lifetimeSeconds = 3600) {
  const prepared = wasm.prepareSession({ abilities: { kv: { "": actions } }, address, chainId: 1,
    domain: "cli.example", spaceId, jwk: key, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + lifetimeSeconds * 1000).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
}

async function stage(delegation: Record<string, unknown>, options: { expectedOwner?: string; grantLifetimeSeconds?: number; resultExpiresAt?: string } = { expectedOwner: ownerDid }) {
  const relay = createECDH("prime256v1"); relay.generateKeys();
  const recipientJwk = relayPublicJwkOf(relay);
  const request = { issuer: did, requestVersion: 1 as const, targetDid: did,
    targetPublicJwk: { kty: key.kty, crv: key.crv, x: key.x }, nodeOrigin: host, permissions: requested,
    grantLifetimeSeconds: options.grantLifetimeSeconds ?? 3600, resultEncryptionPublicJwk: recipientJwk };
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
    resultExpiresAt: options.resultExpiresAt ?? new Date(Date.now() + 600_000).toISOString(), resultEnvelope, ackId: "synthetic-durable-ack-123456789" };
  await writeJsonDurable(join(profilePath("approval"), "approval-pending.json"), [entry]);
  return entry;
}

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment);
  acknowledgements = new Map(); dropAck = false; savedBeforeAck = false; terminalAckCode = undefined; terminalAck = undefined; retainedResultExpiresAt = undefined;
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
  await expect(completeApprovalResult("approval")).rejects.toMatchObject({ code: "APPROVAL_ACK_PENDING" });
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
  await expect(completeApprovalResult("approval")).rejects.toMatchObject({ code: "APPROVAL_ACK_PENDING" });
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

test("an interrupted fetch rediscovers and refetches its original encrypted result before saving", async () => {
  const delegation = await signedDelegation();
  const pending = await stage(delegation);
  const { resultEnvelope: _, ...unfetched } = pending;
  await writeJsonDurable(join(profilePath("approval"), "approval-pending.json"), [unfetched]);
  // The actual signed HTTP fixture retains ciphertext after the client's fetch was lost.
  const encryptedPath = join(profilePath("approval"), "retained-result.json");
  await writeJsonDurable(encryptedPath, pending.resultEnvelope);
  const send = globalThis.fetch;
  const localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== server.url.origin) throw new Error("Unexpected new approval request");
    return send(input, init);
  }, { preconnect: send.preconnect }));
  try {
    const recovered = await acquireApprovalRequest(did, {
      profileName: "approval", jwk: key, host, permissions: requested,
      expectedOwner: ownerDid, expiry: "1h", openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin,
      noPopup: true, onApprovalRequest: () => { throw new Error("Approval was already granted"); },
    });
    expect(recovered.delegationCid).toBe(delegation.delegationCid);
    expect(acknowledgements.has(resultRef)).toBe(false);
    const snapshot = await readProfileSnapshot("approval");
    const verified = verifyScopedLogin(recovered, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
    await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
    await completeApprovalResult("approval", recovered);
    expect(acknowledgements.get(resultRef)).toBe(pending.ackId);
  } finally {
    localOnly.mockRestore();
    await rm(encryptedPath, { force: true });
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
  await expect(completeApprovalResult("approval")).rejects.toMatchObject({ code: expect.stringMatching(/^(?:APPROVAL_RESULT_INVALID|OPENKEY_[A-Z_]+)$/) });
  expect(acknowledgements.has(resultRef)).toBe(false);
  expect(await ProfileManager.getSession("approval")).toBeNull();
});


test.each(["expired_result", "not_found", "acknowledged"])("a terminal %s ACK retires only a durably saved result", async (code) => {
  const delegation = await signedDelegation();
  const pending = await stage(delegation);
  terminalAckCode = code;
  await completeApprovalResult("approval");
  expect(terminalAck).toBeUndefined();
  const snapshot = await readProfileSnapshot("approval");
  const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
  await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
  await completeApprovalResult("approval");
  expect(savedBeforeAck).toBe(true);
  expect(terminalAck).toMatchObject({ requestId, bodyCid: pending.bodyCid, ackId: pending.ackId });
  expect(await readJson(join(profilePath("approval"), "approval-pending.json"))).toEqual([]);
  expect((await ProfileManager.getSession("approval"))?.delegationCid).toBe(delegation.delegationCid);
});

test("logout removes pending signer material and cannot resurrect that key", async () => {
  await stage(await signedDelegation());
  await clearProfileCredentials("approval", true);
  expect(await ProfileManager.getKey("approval")).toBeNull();
  expect(await readJson(join(profilePath("approval"), "approval-pending.json"))).toBeNull();
  expect(await pendingApprovalKey("approval")).toBeUndefined();
  expect((await ProfileManager.getProfile("approval")).authSignedOut).toBe(true);
});

test("housekeeping retires an expired uncommitted delegation without ACK or session", async () => {
  await stage(await signedDelegation(), { expectedOwner: ownerDid, resultExpiresAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 2 * 3600_000);
  try { await completeApprovalResult("approval"); } finally { clock.mockRestore(); }
  expect(await readJson(join(profilePath("approval"), "approval-pending.json"))).toEqual([]);
  expect(await ProfileManager.getSession("approval")).toBeNull();
  expect(acknowledgements.has(resultRef)).toBe(false);
});

test("a login without expiry creates a fresh seven-day request instead of reusing an expired result", async () => {
  await stage(await signedDelegation(), { expectedOwner: ownerDid, grantLifetimeSeconds: 604800, resultExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const send = globalThis.fetch;
  const interrupted = new Error("Owned approval prompt interruption");
  let offered: string | undefined;
  const localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") return send(server.url.origin + url.pathname, init);
    if (url.origin !== server.url.origin) throw new Error("Only the owned fixture may receive requests");
    return send(input, init);
  }, { preconnect: send.preconnect }));
  try {
    await expect(acquireApprovalRequest(did, { profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid,
      openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
      onApprovalRequest: ({ approvalUrl }) => { offered = approvalUrl; throw interrupted; },
    })).rejects.toBe(interrupted);
  } finally { localOnly.mockRestore(); }
  const pending = await readJson<Array<{ requestId: string; request: { grantLifetimeSeconds: number }; signingKey?: unknown }>>(join(profilePath("approval"), "approval-pending.json"));
  expect(pending).toHaveLength(1);
  expect(pending![0]!.requestId).not.toBe(requestId);
  expect(offered).toContain("/a/" + pending![0]!.requestId);
  expect(pending![0]!.request.grantLifetimeSeconds).toBe(604800);
  expect(pending![0]!.signingKey).toBeUndefined();
});


test("an approved result remains discoverable after request expiry when its result window is still open", async () => {
  const delegation = await signedDelegation(["tinycloud.kv/list"], 7200);
  const pending = await stage(delegation, { expectedOwner: ownerDid, grantLifetimeSeconds: 7200, resultExpiresAt: new Date((delegation.siwe as string).match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString() });
  retainedResultExpiresAt = pending.resultExpiresAt;
  const { resultRef: _ref, resultEnvelope: _envelope, resultExpiresAt: _expiry, ...undiscovered } = pending;
  await writeJsonDurable(join(profilePath("approval"), "approval-pending.json"), [undiscovered]);
  const encryptedPath = join(profilePath("approval"), "retained-result.json");
  await writeJsonDurable(encryptedPath, pending.resultEnvelope);
  const send = globalThis.fetch;
  const localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== server.url.origin) throw new Error("An approved result must still be discovered, not replaced");
    return send(input, init);
  }, { preconnect: send.preconnect }));
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now + 90 * 60_000);
  try {
    const recovered = await acquireApprovalRequest(did, { profileName: "approval", jwk: key, host, permissions: requested,
      expectedOwner: ownerDid, expiry: "2h", openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
      onApprovalRequest: ({ requestId: offeredId }) => { expect(offeredId).toBe(requestId); },
    });
    expect(recovered.delegationCid).toBe(delegation.delegationCid);
    expect(acknowledgements.has(resultRef)).toBe(false);
    expect(await ProfileManager.getSession("approval")).toBeNull();
  } finally { clock.mockRestore(); localOnly.mockRestore(); await rm(encryptedPath, { force: true }); }
});
