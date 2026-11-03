// TC-2363 row (b): a PERMANENT post-approval refusal of the fetched result drops the pending approval entry (its result key and
// result reference), as a not_found / expired answer from OpenKey already does. A refusal the resume design keeps on purpose
// (AUTH_EXPIRED) leaves the entry. The result is never ACKed: ACK means "saved", and no discard call exists.
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
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
const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list", "tinycloud.kv/get"] }];
const requestId = "abcdefghijklmnopqrstuvwxyz";
const resultRef = "synthetic-result-reference-123456";
let acknowledgements = new Map<string, string>();
let dropAck = false;
let savedBeforeAck = false;
let terminalAckCode: string | undefined;
/** OpenKey answers the discover or the fetch with this error code (a rejected requester proof, an expired request ...). */
let rejectWith: { action: "discover" | "fetch"; code: string; serverAheadMs?: number } | undefined;
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
  // A version 1 file stays an array until a write that needs one (migration is on the first write), so the fake reads both shapes.
  const stored = await readJson<{ entries: Array<{ phase: string; ackId: string; bodyCid: string; resultEnvelope: unknown; resultExpiresAt: string }> } | Array<{ ackId: string; bodyCid: string; resultEnvelope: unknown; resultExpiresAt: string }>>(join(profilePath("approval"), "approval-pending.json"));
  const pending = Array.isArray(stored) ? stored.map((item) => ({ ...item, phase: "legacy" })) : stored?.entries;
  const session = await ProfileManager.getSession("approval") as Record<string, unknown> | null;
  savedBeforeAck = pending?.[0]?.phase === "committed" && pending[0].ackId === body.ackId && session?.signature !== undefined;
  const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
  if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) return new Response(null, { status: 401 });
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const action = new URL(request.url).pathname.endsWith("/result") ? "discover"
    : new URL(request.url).pathname.endsWith("/fetch") ? "fetch" : "ack";
  const credential = JSON.stringify([action, requestId, body.bodyCid, action === "discover" ? "" : resultRef, action === "ack" ? body.ackId : ""]);
  if (claims.htu !== request.url || claims.htm !== "POST" || claims.client_id !== "openkey-approval-result-v1" ||
    claims.cred_hash !== createHash("sha256").update(credential).digest("base64url")) return new Response(null, { status: 401 });
  if (rejectWith?.action === action) {
    // A reply's `Date` header is how the CLI measures its own clock against OpenKey's.
    const headers = rejectWith.serverAheadMs === undefined ? undefined : { date: new Date(Date.now() + rejectWith.serverAheadMs).toUTCString() };
    return Response.json({ code: rejectWith.code }, { status: rejectWith.code === "expired_request" ? 410 : 401, ...(headers ? { headers } : {}) });
  }
  if (action === "discover") return Response.json({ status: "approved", resultRef, expiresAt: pending![0]!.resultExpiresAt ?? retainedResultExpiresAt });
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

async function signedDelegation(actions = ["tinycloud.kv/list", "tinycloud.kv/get"], lifetimeSeconds = 3600, tamper = false) {
  const prepared = wasm.prepareSession({ abilities: { kv: { "": actions } }, address, chainId: 1,
    domain: "cli.example", spaceId, jwk: key, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + lifetimeSeconds * 1000).toISOString() });
  const signature = await wallet.signMessage(tamper ? "not the message that was approved" : prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
}

async function stage(delegation: Record<string, unknown>, options: { expectedOwner?: string; grantLifetimeSeconds?: number; resultExpiresAt?: string; breakBinding?: boolean } = { expectedOwner: ownerDid }) {
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
  const plaintext = { resultVersion: 1, requestId, requestDigest: prepared.bodyCid, requesterDid: options.breakBinding ? "did:key:someone-else" : did,
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
  acknowledgements = new Map(); dropAck = false; savedBeforeAck = false; terminalAckCode = undefined; rejectWith = undefined; terminalAck = undefined; retainedResultExpiresAt = undefined;
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

const PENDING = () => join(profilePath("approval"), "approval-pending.json");
/** The saved requests, from either file shape: the version 1 array a test staged, or the version 2 file the CLI wrote since. */
const entries = async () => {
  const state = await readJson<Array<{ requestId: string; resultRef?: string }> | { entries: Array<{ requestId: string; resultRef?: string }> }>(PENDING());
  return Array.isArray(state) ? state : state?.entries;
};
const ACQUIRE = { profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
  openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true, onApprovalRequest: () => undefined };

/** A stored request whose result OpenKey still holds, so acquisition discovers, fetches and verifies it (the real first-fetch path). */
async function unfetched(delegation: Record<string, unknown>, options: Parameters<typeof stage>[1] = { expectedOwner: ownerDid }): Promise<void> {
  const pending = await stage(delegation, options);
  const { resultEnvelope: _, ...rest } = pending;
  await writeJsonDurable(PENDING(), [rest]);
  await writeJsonDurable(join(profilePath("approval"), "retained-result.json"), pending.resultEnvelope);
}

describe("a fetched result that is refused for good drops its pending entry", () => {
  test("OPENKEY_APPROVAL_NARROWER (the owner unticked an item): the entry, its result key and reference are gone; nothing was ACKed", async () => {
    await unfetched(await signedDelegation(["tinycloud.kv/list"]));
    await expect(acquireApprovalRequest(did, ACQUIRE)).rejects.toMatchObject({ code: "OPENKEY_APPROVAL_NARROWER" });
    expect(await entries()).toEqual([]);
    expect(await pendingApprovalKey("approval")).toBeUndefined();
    expect(acknowledgements.size).toBe(0);
  });

  test("OPENKEY_OWNER_MISMATCH (another account approved): the entry is gone", async () => {
    await unfetched(await signedDelegation(), { expectedOwner: "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD" });
    await expect(acquireApprovalRequest(did, { ...ACQUIRE, expectedOwner: "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD" }))
      .rejects.toMatchObject({ code: "OPENKEY_OWNER_MISMATCH" });
    expect(await entries()).toEqual([]);
    expect(acknowledgements.size).toBe(0);
  });

  test("OPENKEY_PROOF_INVALID (a result whose signature is not the owner's): the entry is gone", async () => {
    await unfetched(await signedDelegation(undefined, 3600, true));
    await expect(acquireApprovalRequest(did, ACQUIRE)).rejects.toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    expect(await entries()).toEqual([]);
  });

  test("only the refused entry goes: another pending request of the profile stays", async () => {
    await unfetched(await signedDelegation(["tinycloud.kv/list"]));
    const [refused] = (await entries())!;
    await writeJsonDurable(PENDING(), [refused, { ...refused, requestId: "anotherrequestidentifierab", commandIntent: "auth-grant:" + "a".repeat(64) }]);
    await expect(acquireApprovalRequest(did, ACQUIRE)).rejects.toMatchObject({ code: "OPENKEY_APPROVAL_NARROWER" });
    expect((await entries())!.map((entry) => entry.requestId)).toEqual(["anotherrequestidentifierab"]);
  });

  test("AUTH_EXPIRED stays by design: the entry is kept to resume", async () => {
    await unfetched(await signedDelegation(undefined, -30));
    await expect(acquireApprovalRequest(did, ACQUIRE)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
    expect(acknowledgements.size).toBe(0);
  });

  test("an APPROVED result is untouched: it verifies, keeps its entry until committed, and is ACKed only after the save", async () => {
    await unfetched(await signedDelegation());
    const verified = await acquireApprovalRequest(did, ACQUIRE);
    expect(verified.delegationCid).toBeString();
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
    expect(acknowledgements.size).toBe(0);
  });
});

const { refusing } = await import("./refused-approval.js");
const { dropRefusedApproval } = await import("./approval-request.js");

/** stderr is captured only while a step runs (a global spy would also swallow bun's own report). */
async function noticeOf(step: () => Promise<unknown>): Promise<string[]> {
  const written: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => { written.push(String(chunk)); return true; }) as never);
  try { await step().catch(() => undefined); } finally { spy.mockRestore(); }
  return written.join("").split("\n").filter((line) => /OpenKey (granted this approval|may already have granted)/.test(line));
}

describe("the refusal of a fetched result is announced where the command catches it", () => {
  test("a stored key: ONE notice names the refused delegation's CID and says the key still exists; the pending request is gone", async () => {
    const delegation = await signedDelegation(["tinycloud.kv/list"]);
    await unfetched(delegation);
    const notices = await noticeOf(() => refusing({ profileName: "approval", key, storedKey: key }, () => acquireApprovalRequest(did, ACQUIRE)));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith(`Refused delegation: ${delegation.delegationCid}. OpenKey granted this approval until `);
    expect(notices[0]).toContain("the key it belongs to still exists on this device");
    expect(notices[0]).toContain("cannot revoke it");
    expect(notices[0]).toContain("https://account.tinycloud.xyz/delegations");
    expect(await entries()).toEqual([]);
  });

  test("a first sign-in's key that lived only in the refused request: the notice says it was deleted", async () => {
    await unfetched(await signedDelegation(["tinycloud.kv/list"]));
    const notices = await noticeOf(() => refusing({ profileName: "approval", key, storedKey: null }, () => acquireApprovalRequest(did, ACQUIRE)));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("its key was deleted, so it cannot be used");
    expect(await pendingApprovalKey("approval")).toBeUndefined();
  });

  test("the same key still held by another pending request: it still exists, so the notice does not say it was deleted", async () => {
    await unfetched(await signedDelegation(["tinycloud.kv/list"]));
    const [refused] = (await entries())!;
    await writeJsonDurable(PENDING(), [refused, { ...refused, requestId: "anotherrequestidentifierab", resultRef: undefined, commandIntent: "auth-grant:" + "b".repeat(64) }]);
    const notices = await noticeOf(() => refusing({ profileName: "approval", key, storedKey: null }, () => acquireApprovalRequest(did, ACQUIRE)));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("the key it belongs to still exists on this device");
    expect(notices[0]).not.toContain("its key was deleted");
  });

  test("AUTH_EXPIRED prints no notice and keeps the request", async () => {
    await unfetched(await signedDelegation(undefined, -30));
    expect(await noticeOf(() => refusing({ profileName: "approval", key, storedKey: key }, () => acquireApprovalRequest(did, ACQUIRE)))).toEqual([]);
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
  });

  test("a result refused by the CALLER's own checks (not at the fetch): its pending request is dropped by the result it returned; another result is not touched", async () => {
    await unfetched(await signedDelegation());
    const verified = await acquireApprovalRequest(did, ACQUIRE);
    await dropRefusedApproval("approval", { ...verified });
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
    await dropRefusedApproval("approval", verified);
    expect(await entries()).toEqual([]);
  });
});

describe("a result whose binding does not match its request (APPROVAL_RESULT_INVALID)", () => {
  test("the pending request is dropped and ONE notice names the delegation it carried; no ACK", async () => {
    const delegation = await signedDelegation();
    await unfetched(delegation, { expectedOwner: ownerDid, breakBinding: true });
    let thrown: unknown;
    const notices = await noticeOf(() => refusing({ profileName: "approval", key, storedKey: key }, () => acquireApprovalRequest(did, ACQUIRE).catch((error) => { thrown = error; throw error; })));
    expect(thrown).toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
    expect(await entries()).toEqual([]);
    expect(acknowledgements.size).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith(`Refused delegation: ${delegation.delegationCid}. `);
  });
});

describe("a ceiling exceeded only because the CLI's clock is behind is kept like AUTH_EXPIRED", () => {
  // OpenKey signed Issued At + the requested hour. The CLI's ceiling is its clock + the hour + 30 s, so a clock 2 minutes behind
  // makes the approval look too long. The entry stays: the same command resumes it once the ceiling has caught up.
  test("clock 2 min behind, lifetime as requested: OPENKEY_EXPIRY_EXCEEDED, entry kept, no notice", async () => {
    await unfetched(await signedDelegation(undefined, 3599)); // Issued At is 1 s before: Expiration = Issued At + 1 h
    setSystemTime(new Date(Date.now() - 120_000));
    try {
      let thrown: unknown;
      const notices = await noticeOf(() => refusing({ profileName: "approval", key, storedKey: key }, () => acquireApprovalRequest(did, ACQUIRE).catch((error) => { thrown = error; throw error; })));
      expect(thrown).toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
      expect(notices).toEqual([]);
    } finally { setSystemTime(); }
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
  });

  test("the same clock, a lifetime really above the request (3 days for 1 hour): permanent, entry dropped, one notice", async () => {
    await unfetched(await signedDelegation(undefined, 3 * 86400));
    setSystemTime(new Date(Date.now() - 120_000));
    let notices: string[] = [];
    try {
      notices = await noticeOf(() => refusing({ profileName: "approval", key, storedKey: key }, () => acquireApprovalRequest(did, ACQUIRE)));
    } finally { setSystemTime(); }
    expect(notices).toHaveLength(1);
    expect(await entries()).toEqual([]);
  });
});

const { refreshOpenKeySession } = await import("../commands/auth.js");
describe("auth rotate: a post-approval failure drops the request that holds the staged private key", () => {
  const otherKey = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
  const viaRequest = (afterApproval: () => Promise<void>) => async (d: string, flow: Record<string, unknown>) => {
    const result = await acquireApprovalRequest(d, { ...flow, ...ACQUIRE } as never);
    await afterApproval();
    return result;
  };
  const changeKeyMeanwhile = async () => { await ProfileManager.setKey("approval", otherKey); };

  test("rotation (the staged key is only in the request): PROFILE_CHANGED_DURING_LOGIN after the approval drops the entry", async () => {
    const oldKey = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
    await ProfileManager.setKey("approval", oldKey);
    await unfetched(await signedDelegation());
    await expect(refreshOpenKeySession("approval", host, {
      rotation: { jwk: key, did }, openKeyAcquisition: viaRequest(changeKeyMeanwhile) as never,
    })).rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
    expect(await entries()).toEqual([]);
  });

  test("a plain login (the key is key.json's, so the entry can be resumed): the same failure KEEPS the entry", async () => {
    await unfetched(await signedDelegation());
    await expect(refreshOpenKeySession("approval", host, {
      openKeyAcquisition: viaRequest(changeKeyMeanwhile) as never,
    })).rejects.toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
  });
});

describe("auth rotate: a failure raised INSIDE the approval fetch (before the result is in hand) still drops the request that holds the staged key", () => {
  const oldKey = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
  const rotate = () => refreshOpenKeySession("approval", host, {
    rotation: { jwk: key, did }, openKeyAcquisition: (async (d: string, flow: Record<string, unknown>) => acquireApprovalRequest(d, { ...flow, ...ACQUIRE } as never)) as never,
  });
  const plain = () => refreshOpenKeySession("approval", host, {
    openKeyAcquisition: (async (d: string, flow: Record<string, unknown>) => acquireApprovalRequest(d, { ...flow, ...ACQUIRE } as never)) as never,
  });
  /** What a CLI clock 2 minutes behind OpenKey's does to an approval whose lifetime is as requested. */
  const behind = async <T>(run: () => Promise<T>): Promise<T> => {
    setSystemTime(new Date(Date.now() - 120_000));
    try { return await run(); } finally { setSystemTime(); }
  };
  const withNotices = async (run: () => Promise<unknown>) => {
    let thrown: unknown;
    const notices = await noticeOf(() => run().catch((error) => { thrown = error; throw error; }));
    return { thrown, notices };
  };
  const OTHER = "did:pkh:eip155:1:0x000000000000000000000000000000000000dEaD";
  const arrange = async (lifetimeSeconds: number | undefined) => {
    await ProfileManager.setKey("approval", oldKey);
    await ProfileManager.setSession("approval", { delegationCid: "old-session-cid-0123456789", siwe: "old", signature: "0x00" });
    await unfetched(await signedDelegation(undefined, lifetimeSeconds));
    return { key: JSON.stringify(await ProfileManager.getKey("approval")), session: JSON.stringify(await ProfileManager.getSession("approval")), profile: JSON.stringify(await ProfileManager.getProfile("approval")) };
  };

  test("clock 2 min behind (OPENKEY_EXPIRY_EXCEEDED, clock-dependent): no pending entry is left, ONE notice says the key was deleted, the old login is byte for byte unchanged", async () => {
    const before = await arrange(3599);
    const { thrown, notices } = await behind(() => withNotices(rotate));
    expect(thrown).toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(await entries()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("the new key was deleted, so it cannot be used");
    expect(notices[0]).toContain("Your current login and its key are unchanged.");
    expect(notices[0]).toContain("cannot revoke it");
    expect(JSON.stringify(await ProfileManager.getKey("approval"))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession("approval"))).toBe(before.session);
    expect(JSON.stringify(await ProfileManager.getProfile("approval"))).toBe(before.profile);
  });

  test("AUTH_EXPIRED at the same point: same", async () => {
    const before = await arrange(-30);
    const { thrown, notices } = await withNotices(rotate);
    expect(thrown).toMatchObject({ code: "AUTH_EXPIRED" });
    expect(await entries()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("the new key was deleted, so it cannot be used");
    expect(notices[0]).not.toContain("its key was deleted");
    expect(JSON.stringify(await ProfileManager.getKey("approval"))).toBe(before.key);
    expect(JSON.stringify(await ProfileManager.getSession("approval"))).toBe(before.session);
  });

  test("only the request holding the staged key goes: another request of the profile, and another profile's request for the same key, stay", async () => {
    await arrange(3599);
    const [staged] = (await entries())!;
    await writeJsonDurable(PENDING(), [staged, { ...staged, requestId: "anotherrequestidentifierab", resultRef: undefined, commandIntent: "auth-grant:" + "c".repeat(64), signingKey: oldKey }]);
    await ProfileManager.setProfile("approval-other", { name: "approval-other", did, sessionDid: did, ownerDid: OTHER, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString() } as never);
    const otherFile = join(profilePath("approval-other"), "approval-pending.json");
    await writeJsonDurable(otherFile, [staged]);
    await behind(() => withNotices(rotate));
    expect((await entries())!.map((entry) => entry.requestId)).toEqual(["anotherrequestidentifierab"]);
    expect((await readJson<Array<{ requestId: string }>>(otherFile))!.map((entry) => entry.requestId)).toEqual([requestId]);
  });

  test("a permanent refusal on a rotation (NARROWER at the fetch) still prints exactly ONE notice and leaves no entry", async () => {
    await arrange(3599);
    await unfetched(await signedDelegation(["tinycloud.kv/list"]));
    const { thrown, notices } = await withNotices(rotate);
    expect(thrown).toMatchObject({ code: "OPENKEY_APPROVAL_NARROWER" });
    expect(await entries()).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  test("a rotation that fails BEFORE any approval arrived (no result yet) drops its request but prints no notice", async () => {
    await arrange(3599);
    const [staged] = (await entries())!;
    const { resultRef: _r, resultEnvelope: _e, resultExpiresAt: _x, ...waiting } = staged as Record<string, unknown>;
    // Another request of the profile that DID get its result, holding another key: it is neither dropped nor announced.
    const unrelated = { ...staged, requestId: "anotherrequestidentifierab", commandIntent: "auth-grant:" + "d".repeat(64), signingKey: oldKey };
    await writeJsonDurable(PENDING(), [waiting, unrelated]);
    const { thrown, notices } = await withNotices(() => refreshOpenKeySession("approval", host, {
      rotation: { jwk: key, did }, openKeyAcquisition: (async () => { throw new Error("network went away"); }) as never,
    }));
    expect((thrown as Error).message).toBe("network went away");
    expect(notices).toEqual([]);
    expect((await entries())!.map((entry) => entry.requestId)).toEqual(["anotherrequestidentifierab"]);
  });

  test("a permanent refusal raised by the caller's own checks AFTER the result came back: the entry is dropped and the notice is printed ONCE, not twice", async () => {
    await arrange(3599);
    const { thrown, notices } = await withNotices(() => refreshOpenKeySession("approval", host, {
      rotation: { jwk: key, did },
      // The fetch-time checks accept the result; the caller's own signature check then refuses this altered copy.
      openKeyAcquisition: (async (d: string, flow: Record<string, unknown>) => ({
        ...(await acquireApprovalRequest(d, { ...flow, ...ACQUIRE } as never)), signature: "0x" + "00".repeat(65),
      })) as never,
    }));
    expect(thrown).toMatchObject({ code: "OPENKEY_PROOF_INVALID" });
    expect(await entries()).toEqual([]);
    expect(notices).toHaveLength(1);
  });

  test("a PLAIN login with the clock behind KEEPS its entry, deletes nothing and prints no notice", async () => {
    await ProfileManager.setKey("approval", key);
    await unfetched(await signedDelegation(undefined, 3599));
    const { thrown, notices } = await behind(() => withNotices(plain));
    expect(thrown).toMatchObject({ code: "OPENKEY_EXPIRY_EXCEEDED" });
    expect(notices).toEqual([]);
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
    expect(JSON.stringify(await ProfileManager.getKey("approval"))).toBe(JSON.stringify(key));
  });
});

describe("an approval the CLI cannot collect: OpenKey rejects the requester proof (a CLI clock behind OpenKey's) after the link was shown", () => {
  // R6: the owner approved and OpenKey activated the grant, but every poll of this CLI is answered `invalid_proof`. The CLI never learns
  // the result reference or the delegation, so it cannot name the grant, but it must not abandon the request in silence.
  const oldKey = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
  const viaRequest = async (d: string, flow: Record<string, unknown>) => acquireApprovalRequest(d, { ...flow, ...ACQUIRE } as never);
  const rotate = () => refreshOpenKeySession("approval", host, { rotation: { jwk: key, did }, openKeyAcquisition: viaRequest as never });
  const plain = () => refreshOpenKeySession("approval", host, { openKeyAcquisition: viaRequest as never });
  const withNotices = async (run: () => Promise<unknown>) => {
    let thrown: unknown;
    const notices = await noticeOf(() => run().catch((error) => { thrown = error; throw error; }));
    return { thrown, notices };
  };
  /** A stored request that never got its result (no result reference on disk). */
  const waiting = async () => {
    await unfetched(await signedDelegation());
    const [staged] = (await entries())!;
    const { resultRef: _r, resultEnvelope: _e, resultExpiresAt: _x, ...rest } = staged as Record<string, unknown>;
    await writeJsonDurable(PENDING(), [rest]);
  };
  const GENERIC = "OpenKey may already have granted this approval; this CLI did not use it and cannot revoke it; check and revoke at https://account.tinycloud.xyz/delegations.";

  test("(a) rotation, the discover is rejected: the request is dropped and ONE generic notice (no CID, no date) says the grant may exist; the current login is unchanged", async () => {
    await ProfileManager.setKey("approval", oldKey);
    const before = JSON.stringify(await ProfileManager.getKey("approval"));
    await waiting();
    rejectWith = { action: "discover", code: "invalid_proof" };
    const { thrown, notices } = await withNotices(rotate);
    expect(thrown).toMatchObject({ code: "APPROVAL_RESULT_INVALID", message: "OpenKey rejected the request or requester binding." });
    expect(await entries()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(`${GENERIC} The new key was deleted, so it cannot be used. Your current login and its key are unchanged.`);
    expect(JSON.stringify(await ProfileManager.getKey("approval"))).toBe(before);
  });

  test("(a) rotation, the FETCH is rejected (the result reference is known, so the approval arrived): ONE notice without a CID, 'at the latest until' the request's own bound", async () => {
    await ProfileManager.setKey("approval", oldKey);
    await unfetched(await signedDelegation());
    const [staged] = (await entries())!;
    const { resultEnvelope: _e, ...fetched } = staged as Record<string, unknown>;
    await writeJsonDurable(PENDING(), [fetched]);
    rejectWith = { action: "fetch", code: "request_binding" };
    const { thrown, notices } = await withNotices(rotate);
    expect(thrown).toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
    expect(await entries()).toEqual([]);
    expect(notices).toHaveLength(1);
    const latest = new Date(Date.parse((staged as { requestExpiresAt: string }).requestExpiresAt) + 3600 * 1000).toISOString();
    expect(notices[0]).toStartWith(`OpenKey granted this approval at the latest until ${latest}, but this CLI did not use it and the new key was deleted, so it cannot be used.`);
    expect(notices[0]).toContain("Your current login and its key are unchanged. This CLI cannot revoke it; revoke it at https://account.tinycloud.xyz/delegations.");
    expect(notices[0]).not.toContain("Refused delegation:");
  });

  test("(b1) a PLAIN request-flow login with the same rejection and a sane clock: the proof is permanently wrong, so the request is dropped (exit 5), the key stays, NO notice", async () => {
    await ProfileManager.setKey("approval", key);
    await waiting();
    rejectWith = { action: "discover", code: "invalid_proof" };
    const { thrown, notices } = await withNotices(plain);
    expect(thrown).toMatchObject({ code: "APPROVAL_RESULT_INVALID", exitCode: 5 });
    expect(notices).toEqual([]);
    expect(await entries()).toEqual([]);
    expect(JSON.stringify(await ProfileManager.getKey("approval"))).toBe(JSON.stringify(key));
  });

  test("(b2) the same login with OpenKey's Date two minutes ahead of this clock: nothing is dropped (it resumes once the clock is right), APPROVAL_CLOCK exit 12, the key stays, NO notice", async () => {
    await ProfileManager.setKey("approval", key);
    await waiting();
    rejectWith = { action: "discover", code: "invalid_proof", serverAheadMs: 120_000 };
    const { thrown, notices } = await withNotices(plain);
    expect(thrown).toMatchObject({ code: "APPROVAL_CLOCK", exitCode: 12 });
    expect(notices).toEqual([]);
    expect((await entries())!.map((entry) => entry.requestId)).toEqual([requestId]);
    expect(JSON.stringify(await ProfileManager.getKey("approval"))).toBe(JSON.stringify(key));
  });

  test("(c) a rotation whose request expired unanswered (the owner never approved): the request goes, NO notice: nothing was granted", async () => {
    await ProfileManager.setKey("approval", oldKey);
    await waiting();
    rejectWith = { action: "discover", code: "expired_request" };
    const { thrown, notices } = await withNotices(rotate);
    expect(thrown).toMatchObject({ code: "APPROVAL_REQUEST_EXPIRED" });
    expect(notices).toEqual([]);
    expect(await entries()).toEqual([]);
  });

  test("(c) a rotation whose request cannot even be created: no entry, NO notice", async () => {
    await ProfileManager.setKey("approval", oldKey);
    const { thrown, notices } = await withNotices(() => refreshOpenKeySession("approval", host, {
      rotation: { jwk: key, did }, openKeyAcquisition: (async () => { throw new Error("could not create the approval request"); }) as never,
    }));
    expect((thrown as Error).message).toBe("could not create the approval request");
    expect(notices).toEqual([]);
    expect((await entries()) ?? []).toEqual([]);
  });
});
