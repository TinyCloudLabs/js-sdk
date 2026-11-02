import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

// TC-2323: a stored approval request that expired before anyone approved it must end the command (exit 3) and be
// dropped, not loop forever. These tests drive acquireApprovalRequest without any deadline option, against a signed
// local OpenKey fixture; a request that is still open would be polled for ever, so the tests either approve it first
// or leave through the onApprovalRequest callback.

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC2323-expired-request-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
Object.assign(process.env, fixtureEnvironment);
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson, writeJsonDurable } = await import("../config/storage.js");
const { readProfileSnapshot, commitLogin } = await import("./login-commit.js");
const { acquireApprovalRequest, completeApprovalResult } = await import("./approval-request.js");
const { verifyScopedLogin } = await import("./scoped-login.js");
const { relayPublicJwkOf } = await import("./device-auth.js");
const { CLIError } = await import("../output/errors.js");
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
const pendingPath = () => join(profilePath("approval"), "approval-pending.json");

interface Pending {
  requestId: string; bodyCid: string; approvalUrl: string; requestExpiresAt: string; resultRef?: string;
  resultEnvelope?: unknown; committed?: boolean; acknowledged?: boolean; ackId: string;
  request: { resultEncryptionPublicJwk: { x: string; y: string } };
}

// ---- OpenKey fixture ----
const results = new Map<string, { resultRef: string; expiresAt: string; relay: unknown }>();
let linkPosts = 0;
let discoverCalls = 0;
let fetchCalls = 0;
let acks: Array<{ ackId: string; resultRef: string }> = [];
let ackSeenSaved: Array<{ committed: boolean; envelopeOnDisk: boolean; sessionOnDisk: boolean }> = [];
let expireRequests = false;
/** What production OpenKey answers a discover for a request whose signed header has expired: HTTP 400, code invalid_request (not expired_request). */
let discoverRefusal: { error: string; code?: string } | undefined;
let lastRequestId = "";

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/v1/links") {
    linkPosts++;
    const record = await request.json() as { header: { expiresAt: string } };
    lastRequestId = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    return Response.json({ id: lastRequestId, expiresAt: record.header.expiresAt }, { status: 201 });
  }
  const body = await request.json() as { requestId?: string; bodyCid: string; ackId?: string };
  const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
  if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) return new Response(null, { status: 401 });
  const discover = path.match(/^\/api\/approval-requests\/([a-z]{26})\/result$/);
  if (discover) {
    discoverCalls++;
    if (discoverRefusal) return Response.json(discoverRefusal, { status: 400 });
    if (expireRequests) return Response.json({ code: "expired_request" }, { status: 410 });
    const result = results.get(discover[1]!);
    if (!result) return new Response(null, { status: 202 });
    return Response.json({ resultRef: result.resultRef, expiresAt: result.expiresAt });
  }
  const delivery = path.match(/^\/api\/approval-results\/([A-Za-z0-9_-]+)\/(fetch|ack)$/);
  const found = delivery ? [...results.entries()].find(([, value]) => value.resultRef === delivery[1]) : undefined;
  if (!delivery || !found) return new Response(null, { status: 404 });
  const [requestId, result] = found;
  if (delivery[2] === "fetch") {
    fetchCalls++;
    return Response.json({ requestId, bodyCid: body.bodyCid, resultRef: result.resultRef, expiresAt: result.expiresAt, relay: result.relay });
  }
  const saved = await readJson<Pending[]>(pendingPath());
  const entry = saved?.find((item) => item.requestId === requestId);
  const session = await ProfileManager.getSession("approval") as Record<string, unknown> | null;
  ackSeenSaved.push({ committed: entry?.committed === true && entry.ackId === body.ackId,
    envelopeOnDisk: entry?.resultEnvelope !== undefined && entry.resultRef === result.resultRef, sessionOnDisk: session?.signature !== undefined });
  acks.push({ ackId: body.ackId!, resultRef: result.resultRef });
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
} });

async function signedDelegation(lifetimeSeconds = 3600) {
  const prepared = wasm.prepareSession({ abilities: { kv: { "": ["tinycloud.kv/list"] } }, address, chainId: 1,
    domain: "cli.example", spaceId, jwk: key, issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + lifetimeSeconds * 1000).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
}

/** The owner approves the newest pending request: an encrypted, owner-signed result appears at OpenKey. */
async function approve(): Promise<void> {
  const entries = await readJson<Pending[]>(pendingPath()) ?? [];
  const entry = entries.at(-1);
  if (!entry) throw new Error("No pending request to approve");
  const delegation = await signedDelegation();
  const recipient = entry.request.resultEncryptionPublicJwk;
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(entry.requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(entry.requestId));
  const delegationExpiresAt = new Date((delegation.siwe as string).match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
  const plaintext = { resultVersion: 1, requestId: entry.requestId, requestDigest: entry.bodyCid, requesterDid: did,
    ownerDid, targetDid: did, delegationExpiresAt, delegation };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  results.set(entry.requestId, {
    resultRef: randomBytes(24).toString("base64url"), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    relay: { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral),
      nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") },
  });
}

let networkFault: (url: URL) => boolean = () => false;
let offered: string[] = [];
const send = globalThis.fetch;
let fetchSpy: Mock<typeof fetch> | undefined;

/** Every call that reached the fake OpenKey (not the links API), to prove a local decision made none. */
let openkeyCalls = 0;
let onRequest: (url: URL, init?: RequestInit) => Promise<void> | void = () => undefined;
async function route(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  // The links API is OpenKey's own host in production; here its one route lands on the fixture.
  if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") return send(server.url.origin + url.pathname, init);
  if (url.origin !== server.url.origin) throw new Error("Only the owned fixture may receive requests");
  openkeyCalls++;
  await onRequest(url, init);
  if (networkFault(url)) throw new TypeError("fetch failed");
  return send(input, init);
}
const routed = Object.assign(route, { preconnect: send.preconnect });

function options(onOffer: (approvalUrl: string) => void = (approvalUrl) => { offered.push(approvalUrl); }) {
  return {
    profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
    openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
    onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => onOffer(approvalUrl),
  };
}

async function pendingOf(run: () => Promise<unknown>): Promise<InstanceType<typeof CLIError>> {
  try { await run(); } catch (error) {
    if (error instanceof CLIError) return error;
    throw error;
  }
  throw new Error("The wait ended without an error");
}
const entries = async () => await readJson<Pending[]>(pendingPath()) ?? [];

async function commitAndAcknowledge(delegation: Record<string, unknown>): Promise<void> {
  const snapshot = await readProfileSnapshot("approval");
  const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
  await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
  await completeApprovalResult("approval", delegation);
}

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment);
  results.clear(); linkPosts = 0; discoverCalls = 0; fetchCalls = 0; acks = []; ackSeenSaved = []; expireRequests = false; discoverRefusal = undefined;
  networkFault = () => false; openkeyCalls = 0; onRequest = () => undefined; offered = [];
  await rm(pendingPath(), { force: true });
  await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey("approval", key);
  await ProfileManager.clearSession("approval");
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(routed);
});
afterEach(async () => {
  fetchSpy?.mockRestore();
  try { await rm(pendingPath(), { force: true }); } finally { restoreEnvironment(caseEnvironment); }
});
afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

const REAL_SHAPE = { error: "Signed approval request header is invalid or expired", code: "invalid_request" };
const LEFT = new Error("left the wait through the offer callback");

/** Makes a request and saves it: the callback that shows its link stops the call, as a closed terminal would. */
async function createPending(): Promise<Pending> {
  await expect(acquireApprovalRequest(did, options(() => { throw LEFT; }))).rejects.toBe(LEFT);
  const [saved] = await entries();
  return saved!;
}
/** Rewrites the saved entry's own expiry to `agoMs` before now (negative: that long from now). */
async function expireLocally(agoMs: number): Promise<void> {
  const [saved] = await entries();
  await writeJsonDurable(pendingPath(), [{ ...saved!, requestExpiresAt: new Date(Date.now() - agoMs).toISOString() }]);
}
/** The owner approves the newest pending request: an encrypted, owner-signed result appears at OpenKey. */
async function approve(): Promise<void> {
  const entry = (await entries()).at(-1);
  if (!entry) throw new Error("No pending request to approve");
  const delegation = await signedDelegation();
  const recipient = entry.request.resultEncryptionPublicJwk;
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(entry.requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(entry.requestId));
  const delegationExpiresAt = new Date((delegation.siwe as string).match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
  const plaintext = { resultVersion: 1, requestId: entry.requestId, requestDigest: entry.bodyCid, requesterDid: did,
    ownerDid, targetDid: did, delegationExpiresAt, delegation };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  results.set(entry.requestId, {
    resultRef: randomBytes(24).toString("base64url"), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    relay: { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral),
      nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") },
  });
}

describe("without --timeout, an approval request that expired unanswered ends the command instead of looping", () => {
  test("(b) production OpenKey's real answer to a discover for an expired request, HTTP 400 invalid_request, is exit 3 and drops the entry, never exit 8", async () => {
    await createPending();
    await expireLocally(30_000); // inside the 60 s skew: the local check leaves it to OpenKey
    discoverRefusal = REAL_SHAPE;
    const error = await pendingOf(() => acquireApprovalRequest(did, options()));
    expect(error.code).toBe("APPROVAL_REQUEST_EXPIRED");
    expect(error.exitCode).toBe(3);
    expect(discoverCalls).toBe(1);
    expect(await entries()).toEqual([]);
  });

  test("(b2) a 400 that only says 'expired' (no code) is the same", async () => {
    await createPending();
    await expireLocally(30_000);
    discoverRefusal = { error: "This request has expired" };
    const error = await pendingOf(() => acquireApprovalRequest(did, options()));
    expect(error.code).toBe("APPROVAL_REQUEST_EXPIRED");
    expect(await entries()).toEqual([]);
  });

  test("(c) the same 400 BEFORE the stored expiry stays APPROVAL_REQUEST_UNAVAILABLE, exit 8, entry kept (it could be a real fault)", async () => {
    const saved = await createPending();
    discoverRefusal = REAL_SHAPE;
    const error = await pendingOf(() => acquireApprovalRequest(did, options()));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(8);
    expect((await entries()).map((item) => item.requestId)).toEqual([saved.requestId]);
  });

  test("(c2) a different 400 after expiry (bad request binding) is refused as before, not turned into an expiry", async () => {
    await createPending();
    await expireLocally(30_000);
    discoverRefusal = { error: "request does not match", code: "request_binding" };
    const error = await pendingOf(() => acquireApprovalRequest(did, options()));
    expect(error.code).toBe("APPROVAL_RESULT_INVALID");
    expect(await entries()).toHaveLength(1);
  });

  test("(c3) OpenKey's own expired_request (HTTP 410) is exit 3 and drops the entry, as before", async () => {
    await createPending();
    expireRequests = true;
    const error = await pendingOf(() => acquireApprovalRequest(did, options()));
    expect(error.code).toBe("APPROVAL_REQUEST_EXPIRED");
    expect(error.exitCode).toBe(3);
    expect(await entries()).toEqual([]);
  });

  test("(d) an expired entry that already holds the fetched result is NOT dropped: it is collected with no OpenKey call", async () => {
    await createPending();
    await approve();
    const first = await acquireApprovalRequest(did, options());
    expect((await entries())[0]!.resultEnvelope).toBeDefined();
    await expireLocally(30 * 60_000);
    openkeyCalls = 0;
    const again = await acquireApprovalRequest(did, options());
    expect(again.delegationCid).toBe(first.delegationCid);
    expect(openkeyCalls).toBe(0);
    await commitAndAcknowledge(again);
    expect(acks).toHaveLength(1);
  });

  test("(d2) an expired entry that has a result reference but no envelope yet is not dropped either", async () => {
    await createPending();
    await approve();
    const failFetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/fetch")) return new Response(null, { status: 500 });
      return route(input, init);
    }, { preconnect: send.preconnect }));
    try {
      const error = await pendingOf(() => acquireApprovalRequest(did, options()));
      expect(error.code).toBe("APPROVAL_RESULT_UNAVAILABLE");
    } finally { failFetch.mockRestore(); }
    expect((await entries())[0]!.resultRef).toBeDefined();
    expect((await entries())[0]!.resultEnvelope).toBeUndefined();
    await expireLocally(30 * 60_000);
    fetchSpy!.mockImplementation(routed);
    const delegation = await acquireApprovalRequest(did, options());
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
  });

  test("(e) the stored expiry having just passed does not hide an approved result: OpenKey still answers 200 with it and it is collected", async () => {
    await createPending();
    await approve();
    await expireLocally(59_000);
    openkeyCalls = 0;
    const delegation = await acquireApprovalRequest(did, options());
    expect(delegation.delegationCid).toBeDefined();
    expect(openkeyCalls).toBeGreaterThan(0);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
  });

  test("(e2) the 400 mapping starts at the stored expiry itself, with no skew: 1 s past is exit 3, 1 s before is exit 8", async () => {
    await createPending();
    discoverRefusal = REAL_SHAPE;
    await expireLocally(-1_000);
    expect((await pendingOf(() => acquireApprovalRequest(did, options()))).code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(await entries()).toHaveLength(1);
    await expireLocally(2_000); // 2 s past
    expect((await pendingOf(() => acquireApprovalRequest(did, options()))).code).toBe("APPROVAL_REQUEST_EXPIRED");
    expect(await entries()).toEqual([]);
  });

  test("(f) the loop ends: after the drop the next run makes a NEW request with a new link", async () => {
    const first = await createPending();
    await expireLocally(20 * 60_000);
    discoverRefusal = REAL_SHAPE;
    expect((await pendingOf(() => acquireApprovalRequest(did, options()))).code).toBe("APPROVAL_REQUEST_EXPIRED");
    discoverRefusal = undefined;
    const second = await createPending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.approvalUrl).not.toBe(first.approvalUrl);
    expect(linkPosts).toBe(2);
    expect(Date.parse(second.requestExpiresAt)).toBeGreaterThan(Date.now());
  });

  test("a request that is still open is untouched: a new link is offered and a resumed one is offered again, as before", async () => {
    const saved = await createPending();
    offered = [];
    await expect(acquireApprovalRequest(did, options(() => { throw LEFT; }))).rejects.toBe(LEFT);
    expect((await entries()).map((item) => item.requestId)).toEqual([saved.requestId]);
    expect(linkPosts).toBe(1);
  });
});
