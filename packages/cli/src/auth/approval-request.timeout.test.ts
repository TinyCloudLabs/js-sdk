import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

// TC-2299: the approval wait is bounded by `--timeout`; these tests drive
// acquireApprovalRequest against a signed local OpenKey fixture with a virtual
// clock. "Killed" seams stop the flow exactly where a SIGKILL would and the next
// call is a fresh start from the saved profile state alone.

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC2299-approval-timeout-");
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
const { APPROVAL_COLLECT_GRACE_MS } = await import("./approval-wait.js");
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
  requestId: string; bodyCid: string; approvalUrl: string; record: { header: { expiresAt: string } }; phase: string; resultRef?: string;
  resultEnvelope?: unknown; ackId: string;
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
    return Response.json({ status: "approved", resultRef: result.resultRef, expiresAt: result.expiresAt });
  }
  const delivery = path.match(/^\/api\/approval-results\/([A-Za-z0-9_-]+)\/(fetch|ack)$/);
  const found = delivery ? [...results.entries()].find(([, value]) => value.resultRef === delivery[1]) : undefined;
  if (!delivery || !found) return new Response(null, { status: 404 });
  const [requestId, result] = found;
  if (delivery[2] === "fetch") {
    fetchCalls++;
    return Response.json({ requestId, bodyCid: body.bodyCid, resultRef: result.resultRef, expiresAt: result.expiresAt, relay: result.relay });
  }
  const saved = (await readJson<{ entries: Pending[] }>(pendingPath()))?.entries;
  const entry = saved?.find((item) => item.requestId === requestId);
  const session = await ProfileManager.getSession("approval") as Record<string, unknown> | null;
  ackSeenSaved.push({ committed: entry?.phase === "committed" && entry.ackId === body.ackId,
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
  const entries = (await readJson<{ entries: Pending[] }>(pendingPath()))?.entries ?? [];
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

// ---- virtual clock ----
const START = Date.parse("2026-11-01T09:00:00.000Z");
let clock = START;
let sleeps: number[] = [];
let onTick: (now: number) => Promise<void> | void = () => undefined;
const virtual = {
  now: () => clock,
  sleep: async (ms: number) => { sleeps.push(ms); clock += ms; await onTick(clock); },
};

let networkFault: (url: URL) => boolean = () => false;
/** Headers arrive with 200, then the body stalls until the request is aborted. */
let stalledBody: (url: URL) => boolean = () => false;
/** Headers arrive with 200, then the body fails at once: a connection reset (Bun raises a plain Error with code ECONNRESET) or malformed JSON. */
let brokenBody: (url: URL) => "reset" | "malformed" | undefined = () => undefined;
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
  const broken = brokenBody(url);
  if (broken === "malformed") return new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
  if (broken === "reset") {
    return new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error("The socket connection was closed unexpectedly"), { code: "ECONNRESET" })); } }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  if (stalledBody(url)) {
    return new Response(new ReadableStream({ start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
    } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return send(input, init);
}
const routed = Object.assign(route, { preconnect: send.preconnect });

function options(wait?: { deadlineMs: number; step?: number; of?: number }, clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = { now: virtual.now, sleep: virtual.sleep }) {
  return {
    profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
    openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
    onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => { offered.push(approvalUrl); },
    ...(wait ? { approvalWait: { step: 1, of: 1, ...wait, ...clock } } : {}),
  };
}
const withDeadline = (ms: number, extra: { step?: number; of?: number } = {}) => options({ deadlineMs: START + ms, ...extra });

async function pendingOf(run: () => Promise<unknown>): Promise<InstanceType<typeof CLIError>> {
  try { await run(); } catch (error) {
    if (error instanceof CLIError) return error;
    throw error;
  }
  throw new Error("The wait ended without an error");
}
const entries = async () => (await readJson<{ entries: Pending[] }>(pendingPath()))?.entries ?? [];

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
  clock = START; sleeps = []; onTick = () => undefined; networkFault = () => false; stalledBody = () => false; brokenBody = () => undefined; openkeyCalls = 0; onRequest = () => undefined; offered = [];
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

describe("a NEW request returns at once, with its link", () => {
  test("exit 8 with exactly the pending fields, before any poll, and the request stays saved", async () => {
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000, { step: 2, of: 2 })));
    expect(error.exitCode).toBe(8);
    expect(error.code).toBe("APPROVAL_PENDING");
    const saved = await entries();
    expect(saved).toHaveLength(1);
    expect(error.metadata).toEqual({ pending: { step: 2, of: 2, approvalUrl: saved[0]!.approvalUrl, expiresAt: saved[0]!.record.header.expiresAt } });
    expect(offered).toEqual([saved[0]!.approvalUrl]);
    expect(saved[0]!.approvalUrl).toContain("/a/" + saved[0]!.requestId);
    expect(new Date(saved[0]!.record.header.expiresAt).toISOString()).toBe(saved[0]!.record.header.expiresAt);
    expect(discoverCalls).toBe(0);
    expect(sleeps).toEqual([]);
    expect(linkPosts).toBe(1);
  });

  test("without a deadline the same call does not return early and behaves as before", async () => {
    // The owner is already approving: the first poll finds the result.
    onRequest = async (url) => { if (url.pathname.endsWith("/result") && !results.size) await approve(); };
    const delegation = await acquireApprovalRequest(did, options());
    expect(delegation.delegationCid).toBeDefined();
    expect(discoverCalls).toBe(1);
    expect(linkPosts).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("a RESUMED request keeps waiting until the deadline", () => {
  test("polls every 2 s and ends at the deadline without another poll, then reports the same link", async () => {
    const first = await pendingOf(() => acquireApprovalRequest(did, withDeadline(30_000)));
    const link = (first.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl;
    const before = await entries();
    expect(discoverCalls).toBe(0);

    const second = await pendingOf(() => acquireApprovalRequest(did, withDeadline(30_000, { step: 1, of: 2 })));
    expect(second.exitCode).toBe(8);
    expect(second.code).toBe("APPROVAL_PENDING");
    expect(second.metadata).toEqual({ pending: { step: 1, of: 2, approvalUrl: link, expiresAt: before[0]!.record.header.expiresAt } });
    expect(linkPosts).toBe(1);
    expect(offered).toEqual([link, link]);
    expect(sleeps.every((ms) => ms <= 2000)).toBe(true);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
    expect(clock).toBe(START + 30_000);
    expect(discoverCalls).toBe(15);
    expect(await entries()).toEqual(before);
  });

  test("a deadline that is not a multiple of the poll interval still ends exactly on it", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    discoverCalls = 0; sleeps = []; clock = START;
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(5_000)));
    expect(sleeps).toEqual([2000, 2000, 1000]);
    expect(discoverCalls).toBe(3);
  });

  test("a deadline that has already passed still asks OpenKey once before giving up", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    discoverCalls = 0;
    await approve();
    clock = START + 10_000;
    const delegation = await acquireApprovalRequest(did, withDeadline(5_000));
    expect(delegation.delegationCid).toBeDefined();
    expect(discoverCalls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("approval before the deadline returns the grant, which is then committed and acknowledged exactly once", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    onTick = async (now) => { if (now === START + 6_000) await approve(); };
    const delegation = await acquireApprovalRequest(did, withDeadline(60_000));
    expect(clock).toBe(START + 6_000);
    expect(linkPosts).toBe(1);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(new Set(acks.map((ack) => ack.ackId)).size).toBe(1);
    expect(ackSeenSaved).toEqual([{ committed: true, envelopeOnDisk: true, sessionOnDisk: true }]);
    expect(await entries()).toEqual([]);
  });

  test("approval landing exactly on the deadline tick is not lost: exit 8 now (the run ends at the deadline without another poll), the next run collects it", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    onTick = async (now) => { if (now === START + 10_000) await approve(); };
    const pending = await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    expect(pending.code).toBe("APPROVAL_PENDING");
    expect(clock).toBe(START + 10_000);
    onTick = () => undefined;
    const delegation = await acquireApprovalRequest(did, withDeadline(10_000));
    expect(linkPosts).toBe(1);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
  });

  test("approval just after the last poll gives exit 8 with the pending entry intact, and the NEXT run resumes the same link with no new request or second approval", async () => {
    const created = await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    const link = (created.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl;
    const expired = await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    expect(expired.code).toBe("APPROVAL_PENDING");
    const kept = await entries();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.resultRef).toBeUndefined();
    expect(kept[0]!.phase).toBe("open");
    await approve();
    clock = START + 10_000; sleeps = [];
    const delegation = await acquireApprovalRequest(did, { ...withDeadline(60_000), onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => { expect(approvalUrl).toBe(link); } });
    expect(linkPosts).toBe(1);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(await entries()).toEqual([]);
  });

  test("OpenKey network errors during the wait of a resumed request are exit 6, never pending: nothing confirmed the request live in this run", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    networkFault = (url) => url.pathname.endsWith("/result");
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect(clock).toBe(START + 7_000);
    expect(await entries()).toHaveLength(1);
  });

  test("a request that expired is exit 3 APPROVAL_REQUEST_EXPIRED, as without --timeout, and its entry is dropped", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    expireRequests = true;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_EXPIRED");
    expect(error.exitCode).toBe(3);
    expect(error.metadata?.pending).toBeUndefined();
    expect(await entries()).toEqual([]);
  });
});

describe("a response body that stalls past the cap is a network failure, never exit 1", () => {
  test("a discover body that stalls is cut by the cap: exit 6 for a resumed request, and the next run resumes", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    await approve();
    onRequest = (url) => url.pathname.endsWith("/result") ? cutShort() : undefined;
    const error = await pendingOf(() => acquireApprovalRequest(did, clock.wait(1_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    onRequest = () => undefined;
    const delegation = await acquireApprovalRequest(did, clock.wait(10_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(linkPosts).toBe(1);
  }, 20_000);

  test("a fetch body that stalls ends as result-unavailable within the grace, and the next run resumes", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    await approve();
    onRequest = (url) => url.pathname.endsWith("/fetch") ? cutShort() : undefined;
    const started = clock.now();
    const error = await pendingOf(() => acquireApprovalRequest(did, clock.wait(1_000)));
    expect(error.code).toBe("APPROVAL_RESULT_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect(clock.elapsed(started)).toBeLessThanOrEqual(1_000 + APPROVAL_COLLECT_GRACE_MS + 2_000);
    onRequest = () => undefined;
    const delegation = await acquireApprovalRequest(did, clock.wait(10_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(linkPosts).toBe(1);
  }, 20_000);
});

describe("an expired request is purged by the load sweep at E + R + S; OpenKey's 410 expired_request is exit 3", () => {
  /** Rewrites the saved entry's own signed expiry to `agoMs` before the (virtual) start. */
  const expireLocally = async (agoMs: number) => {
    const [saved] = await entries();
    await writeJsonDurable(pendingPath(), { version: 2, entries: [{ ...saved!, record: { ...saved!.record, header: { ...saved!.record.header, expiresAt: new Date(START - agoMs).toISOString() } } }], unrecognized: [] });
    return saved!;
  };
  const createPending = () => pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));

  test("(a) past E + R + S the entry and its keys are swept on load with no OpenKey call, and the same run makes a NEW request: exit 8 with a new link", async () => {
    const created = await createPending();
    const oldLink = (created.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl;
    const [old] = await entries();
    await expireLocally(20 * 60_000);
    openkeyCalls = 0;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect((error.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl).not.toBe(oldLink);
    expect(linkPosts).toBe(2);
    expect(openkeyCalls).toBe(0);
    expect((await entries()).map((item) => item.requestId)).not.toContain(old!.requestId);
    expect(sleeps).toEqual([]);
  });

  test("(a2) the same with OpenKey down: the sweep needs no network", async () => {
    await createPending();
    await expireLocally(20 * 60_000);
    networkFault = () => true;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(linkPosts).toBe(2);
    expect(sleeps).toEqual([]);
  });

  test("(a3) a request 5 min past its expiry is NOT swept: OpenKey is asked, and its 410 expired_request is the exit 3 and the drop", async () => {
    await createPending();
    await expireLocally(5 * 60_000);
    openkeyCalls = 0;
    expireRequests = true;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_EXPIRED");
    expect(error.exitCode).toBe(3);
    expect(openkeyCalls).toBe(1);
    expect(await entries()).toEqual([]);
  });

  test("(a4) 90 s past its expiry with OpenKey down: one last check at E + S gets no answer, so exit 6 and the entry is KEPT (an approval given just before expiry may still be served)", async () => {
    await createPending();
    const [saved] = await entries();
    await expireLocally(90_000);
    networkFault = () => true;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect((await entries()).map((item) => item.requestId)).toEqual([saved!.requestId]);
  });

  test("(a5) a request approved just before its expiry is still collected 5 min after it: OpenKey serves the result until its own retention ends", async () => {
    await createPending();
    await approve();
    await expireLocally(5 * 60_000);
    const delegation = await acquireApprovalRequest(did, withDeadline(7_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
  });

  test("(c2) a request_binding answer after expiry is refused, not turned into an expiry, and the never-approved entry is dropped (exit 5)", async () => {
    await createPending();
    await expireLocally(30_000);
    discoverRefusal = { error: "request does not match", code: "request_binding" };
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_RESULT_INVALID");
    expect(error.exitCode).toBe(5);
    expect(await entries()).toEqual([]);
  });

  test("(d) an expired entry that already holds a result is NOT dropped: it is collected", async () => {
    await createPending();
    await approve();
    const first = await acquireApprovalRequest(did, withDeadline(60_000)); // result fetched and saved locally
    expect((await entries())[0]!.resultEnvelope).toBeDefined();
    await expireLocally(5 * 60_000);
    openkeyCalls = 0;
    const again = await acquireApprovalRequest(did, withDeadline(7_000));
    expect(again.delegationCid).toBe(first.delegationCid);
    expect(openkeyCalls).toBe(0);
    expect((await entries()).map((item) => item.resultEnvelope !== undefined)).toEqual([true]);
    await commitAndAcknowledge(again);
    expect(acks).toHaveLength(1);
  });

  test("(d2) an expired entry that has a result reference but no envelope yet is not dropped either", async () => {
    await createPending();
    await approve();
    const [saved] = await entries();
    networkFault = (url) => url.pathname.endsWith("/fetch");
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(2_000))); // discover saved resultRef, fetch kept failing
    networkFault = () => false;
    const [withRef] = await entries();
    expect(withRef!.resultRef).toBeDefined();
    expect(withRef!.resultEnvelope).toBeUndefined();
    await writeJsonDurable(pendingPath(), { version: 2, entries: [{ ...withRef!, record: { ...withRef!.record, header: { ...withRef!.record.header, expiresAt: new Date(START - 5 * 60_000).toISOString() } } }], unrecognized: [] });
    const delegation = await acquireApprovalRequest(did, withDeadline(10_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(saved).toBeDefined();
  });

  test("(f) the loop ends: after the 410 drop the next run makes a NEW request, a new link, step/of in the JSON, exit 8", async () => {
    const first = await createPending();
    const oldLink = (first.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl;
    await expireLocally(30_000);
    expireRequests = true;
    const expired = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000, { step: 2, of: 2 })));
    expect(expired.code).toBe("APPROVAL_REQUEST_EXPIRED");
    expireRequests = false;
    const renewed = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000, { step: 2, of: 2 })));
    expect(renewed.code).toBe("APPROVAL_PENDING");
    expect(renewed.exitCode).toBe(8);
    const pending = (renewed.metadata as { pending: { step: number; of: number; approvalUrl: string; expiresAt: string } }).pending;
    expect(pending.step).toBe(2);
    expect(pending.of).toBe(2);
    expect(pending.approvalUrl).not.toBe(oldLink);
    expect(Date.parse(pending.expiresAt)).toBeGreaterThan(START);
    expect(linkPosts).toBe(2);
    expect(await entries()).toHaveLength(1);
  });

  test("a link that expires DURING the wait, with OpenKey unreachable until the deadline: the check at E + S gets no answer, so exit 6 (never pending with a dead link) and the entry is kept", async () => {
    await createPending();
    const [saved] = await entries();
    await expireLocally(-3_000); // expires 3 s into the wait
    networkFault = (url) => url.pathname.endsWith("/result");
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(70_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect((await entries()).map((item) => item.requestId)).toEqual([saved!.requestId]);
  });

  test("a still-valid link with OpenKey unreachable is exit 6, not pending: nothing confirmed the request live in this run", async () => {
    await createPending();
    const [saved] = await entries();
    networkFault = (url) => url.pathname.endsWith("/result");
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect(error.metadata?.pending).toBeUndefined();
    expect((await entries()).map((item) => item.requestId)).toEqual([saved!.requestId]);
  });
});

/** The real time of a call, with the waiting skipped: a clock that starts at the real now and only moves when it is slept on. */
function stepped() {
  let at = Date.now();
  const clockOf = { now: () => at, sleep: async (ms: number) => { at += ms; } };
  return { ...clockOf, elapsed: (since: number) => at - since, wait: (ms: number) => options({ deadlineMs: at + ms }, clockOf) };
}
/** A request the cap cut short: it fails at once, the way the cap's abort would end it. */
const cutShort = (): Promise<void> => Promise.reject(new TypeError("The operation timed out."));

describe("which body failures are network failures under --timeout", () => {
  test("a connection reset mid-body (a plain Error with code ECONNRESET, as Bun raises it) after a 200 is an unexpected reply, not a network failure: retried five times, exit 7, then the next run resumes", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    await approve();
    brokenBody = (url) => url.pathname.endsWith("/result") ? "reset" : undefined;
    const error = await pendingOf(() => acquireApprovalRequest(did, clock.wait(20_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(7);
    brokenBody = () => undefined;
    const delegation = await acquireApprovalRequest(did, clock.wait(10_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(linkPosts).toBe(1);
  }, 20_000);

  test("a malformed (non-JSON) body is NOT swallowed as a network failure: an unexpected reply, retried, then exit 7", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    await approve();
    brokenBody = (url) => url.pathname.endsWith("/result") ? "malformed" : undefined;
    const first = await pendingOf(() => acquireApprovalRequest(did, clock.wait(20_000)));
    expect(first.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(first.exitCode).toBe(7);
    brokenBody = (url) => url.pathname.endsWith("/fetch") ? "malformed" : undefined;
    const second = await pendingOf(() => acquireApprovalRequest(did, clock.wait(20_000)));
    expect(second.exitCode).toBe(7);
    expect((await entries())[0]!.resultRef).toBeDefined();
  });

  test("OpenKey answered 200 and only the body was cut off: with a link that is just past its stored expiry (inside the 60 s skew) it is an unexpected reply, exit 7 with the entry kept, not exit 3", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    const [saved] = await entries();
    await writeJsonDurable(pendingPath(), { version: 2, entries: [{ ...saved!, record: { ...saved!.record, header: { ...saved!.record.header, expiresAt: new Date(START - 30_000).toISOString() } } }], unrecognized: [] });
    brokenBody = (url) => url.pathname.endsWith("/result") ? "reset" : undefined;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(7);
    expect((await entries()).map((item) => item.requestId)).toEqual([saved!.requestId]);
  });
});

describe("the whole call is bounded by timeout + grace, slow OpenKey", () => {
  test("an unanswered wait whose polls hang ends at the timeout, not one request cap later: exit 6, nothing pending", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    onRequest = (url) => url.pathname.endsWith("/result") ? cutShort() : undefined;
    const started = clock.now();
    const error = await pendingOf(() => acquireApprovalRequest(did, clock.wait(1_000)));
    expect(error.code).toBe("APPROVAL_REQUEST_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect(error.metadata?.pending).toBeUndefined();
    expect(clock.elapsed(started)).toBe(1_000);
  }, 20_000);

  test("an approved result whose fetch hangs ends as result-unavailable within timeout + grace, and resumes later", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    await approve();
    onRequest = (url) => url.pathname.endsWith("/fetch") ? cutShort() : undefined;
    const started = clock.now();
    const error = await pendingOf(() => acquireApprovalRequest(did, clock.wait(1_000)));
    expect(error.code).toBe("APPROVAL_RESULT_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect(error.metadata?.pending).toBeUndefined();
    expect(clock.elapsed(started)).toBeGreaterThanOrEqual(1_000 + APPROVAL_COLLECT_GRACE_MS);
    expect(clock.elapsed(started)).toBeLessThanOrEqual(1_000 + APPROVAL_COLLECT_GRACE_MS + 2_000);
    expect((await entries())[0]!.resultRef).toBeDefined();
    onRequest = () => undefined;
    const delegation = await acquireApprovalRequest(did, clock.wait(10_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(linkPosts).toBe(1);
  }, 20_000);

  test("a hanging ack ends in time as exit 0 with a warning, and the re-run sends it once", async () => {
    const clock = stepped();
    await pendingOf(() => acquireApprovalRequest(did, clock.wait(60_000)));
    await approve();
    const delegation = await acquireApprovalRequest(did, clock.wait(1_000));
    onRequest = (url) => url.pathname.endsWith("/ack") ? cutShort() : undefined;
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write);
    try { await commitAndAcknowledge(delegation); } finally { stderr.mockRestore(); }
    expect(written.join("")).not.toBe("");
    expect(acks).toHaveLength(0);
    onRequest = () => undefined;
    await completeApprovalResult("approval");
    expect(acks).toHaveLength(1);
    expect(await entries()).toEqual([]);
  }, 20_000);
});

describe("after the owner approved, the command finishes even past the deadline", () => {
  test("a flaky result fetch that recovers after the deadline still returns the grant, never exit 8", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    await approve();
    networkFault = (url) => url.pathname.endsWith("/fetch") && clock < START + 10_000 + 10_000;
    clock = START + 10_000;
    const delegation = await acquireApprovalRequest(did, withDeadline(10_000));
    expect(clock).toBeGreaterThanOrEqual(START + 20_000);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
  });

  test("a result that cannot be fetched for longer than the grace ends as exit 6 'result unavailable', not as a pending approval, and resumes later", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    await approve();
    networkFault = (url) => url.pathname.endsWith("/fetch");
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    expect(error.code).toBe("APPROVAL_RESULT_UNAVAILABLE");
    expect(error.exitCode).toBe(6);
    expect(error.metadata?.pending).toBeUndefined();
    expect(clock).toBeGreaterThanOrEqual(START + 10_000 + APPROVAL_COLLECT_GRACE_MS);
    expect(clock).toBeLessThanOrEqual(START + 10_000 + APPROVAL_COLLECT_GRACE_MS + 2_000);
    expect((await entries())[0]!.resultRef).toBeDefined();
    networkFault = () => false;
    const delegation = await acquireApprovalRequest(did, withDeadline(10_000));
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(linkPosts).toBe(1);
  });
});

// A kill is modeled by an error that nothing in the flow catches: the machine's clock throws it at the seam, after the
// reply of the step before it. The next call starts from the profile directory alone. OpenKey keeps its result 600 s.
// The whole describe runs on the real clock, so the entry the first run saved is as young as the next process finds it.
describe("a process killed at any seam resumes from local state: exit-0 completion, one request, one ack", () => {
  const KILLED = new Error("process killed");
  let armed = false;
  const mortalClock = { now: () => { if (armed) { armed = false; throw KILLED; } return Date.now(); }, sleep: async () => undefined };
  const realWait = () => options({ deadlineMs: Date.now() + 60_000 }, mortalClock);

  async function createApprovedRequest(): Promise<void> {
    await pendingOf(() => acquireApprovalRequest(did, realWait()));
    await approve();
  }
  async function finishAfterKill(expectedRequestPosts = 1): Promise<void> {
    const delegation = await acquireApprovalRequest(did, realWait());
    await commitAndAcknowledge(delegation);
    expect(linkPosts).toBe(expectedRequestPosts);
    expect(acks).toHaveLength(1);
    expect(new Set(acks.map((ack) => ack.ackId)).size).toBe(1);
    expect(await entries()).toEqual([]);
    expect(((await ProfileManager.getSession("approval")) as Record<string, unknown> | null)?.delegationCid).toBe(delegation.delegationCid);
  }
  /** The process dies right after the reply of the first call that matches: the next read of the clock throws. */
  function killAfter(match: (url: URL) => boolean) {
    let fired = false;
    fetchSpy!.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = await route(input, init);
      if (!fired && match(url)) { fired = true; await response.clone().text(); armed = true; }
      return response;
    }, { preconnect: send.preconnect }));
  }
  /** The ack reaches OpenKey, its reply never reaches the process. */
  function loseReplyOf(match: (url: URL) => boolean) {
    let fired = false;
    fetchSpy!.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (fired || !match(url)) return route(input, init);
      fired = true;
      const response = await route(input, init);
      await response.clone().text();
      Object.defineProperty(response, "json", { value: async () => { throw new TypeError("The socket connection was closed unexpectedly"); } });
      return response;
    }, { preconnect: send.preconnect }));
  }
  afterEach(() => { armed = false; });

  test("after the poll succeeded, before the result was fetched", async () => {
    await createApprovedRequest();
    killAfter((url) => url.pathname.endsWith("/result"));
    await expect(acquireApprovalRequest(did, realWait())).rejects.toBe(KILLED);
    expect(acks).toHaveLength(0);
    fetchSpy!.mockImplementation(routed);
    await finishAfterKill();
  });

  test("after the result was fetched, before it was saved", async () => {
    await createApprovedRequest();
    killAfter((url) => url.pathname.endsWith("/fetch"));
    await expect(acquireApprovalRequest(did, realWait())).rejects.toBe(KILLED);
    expect(acks).toHaveLength(0);
    expect((await entries())[0]!.resultEnvelope).toBeUndefined();
    fetchSpy!.mockImplementation(routed);
    await finishAfterKill();
  });

  test("after the result was saved, before the login was committed: the next run needs no network to get it back", async () => {
    await createApprovedRequest();
    const delegation = await acquireApprovalRequest(did, realWait());
    const saved = (await entries())[0]!;
    // Saved before commit or ack: the envelope and its OpenKey reference are on disk, fsynced by the durable write.
    expect(saved.resultEnvelope).toBeDefined();
    expect(saved.resultRef).toBeDefined();
    expect(saved.phase).toBe("fetched");
    expect(await ProfileManager.getSession("approval")).toBeNull();
    expect(acks).toHaveLength(0);
    expect(delegation.delegationCid).toBeDefined();
    // Killed here. The retention window at OpenKey may be over: any call to it now fails.
    const discoverBefore = discoverCalls, fetchBefore = fetchCalls;
    networkFault = (url) => url.pathname !== "/v1/links" && !url.pathname.endsWith("/ack");
    const recovered = await acquireApprovalRequest(did, realWait());
    expect(discoverCalls).toBe(discoverBefore);
    expect(fetchCalls).toBe(fetchBefore);
    expect(recovered.delegationCid).toBe(delegation.delegationCid);
    networkFault = () => false;
    await commitAndAcknowledge(recovered);
    expect(acks).toHaveLength(1);
    expect(linkPosts).toBe(1);
    expect(await entries()).toEqual([]);
  });

  test("after the login was committed, before the ack was sent: the next run acknowledges it once", async () => {
    await createApprovedRequest();
    const delegation = await acquireApprovalRequest(did, realWait());
    const snapshot = await readProfileSnapshot("approval");
    const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
    await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
    expect(acks).toHaveLength(0);
    const discoverBefore = discoverCalls, fetchBefore = fetchCalls;
    // The next process is the next command: a resumed `onboard` / `auth grant` first completes the saved result.
    networkFault = (url) => url.pathname !== "/v1/links" && !url.pathname.endsWith("/ack");
    await completeApprovalResult("approval");
    expect(acks).toHaveLength(1);
    expect(ackSeenSaved).toEqual([{ committed: true, envelopeOnDisk: true, sessionOnDisk: true }]);
    expect(discoverCalls).toBe(discoverBefore);
    expect(fetchCalls).toBe(fetchBefore);
    expect(await entries()).toEqual([]);
    expect(linkPosts).toBe(1);
  });

  test("while the ack is in flight and its reply is lost: exit 0 with a warning, and the retry repeats the same ack id (two ack requests, one ack id)", async () => {
    await createApprovedRequest();
    const delegation = await acquireApprovalRequest(did, realWait());
    loseReplyOf((url) => url.pathname.endsWith("/ack"));
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write);
    try { await commitAndAcknowledge(delegation); } finally { stderr.mockRestore(); }
    expect(written.join("")).not.toBe("");
    expect(acks).toHaveLength(1);
    fetchSpy!.mockImplementation(routed);
    await completeApprovalResult("approval");
    expect(new Set(acks.map((ack) => ack.ackId)).size).toBe(1);
    expect(new Set(acks.map((ack) => ack.resultRef)).size).toBe(1);
    expect(await entries()).toEqual([]);
    expect(linkPosts).toBe(1);
  });
});
