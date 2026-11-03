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
const { CLIError, handleError } = await import("../output/errors.js");
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

// ---- TC-2360 follow-up: the FIRST status check of an approval completes, whatever the --timeout ----
// Real harness: `onboard --timeout 1s` run after the owner approved still exited 8 (pending), because the status request was
// aborted after about 1 s (the deadline), while OpenKey took 1.4-2.2 s to answer. The first check of each approval now gets
// the full request limit; only after it has produced an answer does the deadline decide. (Fixture and seams copied from
// approval-request.timeout.test.ts; `requestTimeoutMs` is a seam that shortens the 10 s request limit for the tests.)

/** The status answer arrives after `ms` of real time, and the command's virtual clock moves with it; an aborted request rejects with the abort reason. */
const answerAfter = (ms: number) => async (url: URL, init?: RequestInit) => {
  if (!url.pathname.endsWith("/result")) return;
  await new Promise<void>((resolve, reject) => {
    const timer = ms === Infinity ? undefined : setTimeout(resolve, ms);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
  });
  clock += ms;
};
/** `--timeout` of `ms`, the first check allowed `requestMs`. */
const shortWait = (ms: number, requestMs: number) => options({ deadlineMs: START + ms, requestTimeoutMs: requestMs } as { deadlineMs: number });

describe("the first status check completes whatever the --timeout", () => {
  const SLOW = 1_500;
  const LIMIT = 8_000;

  test("(1) the owner approved and OpenKey answers slowly (1.5 s) with --timeout 1s: the command succeeds, it is not exit 8", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    await approve();
    onRequest = answerAfter(SLOW);
    const delegation = await acquireApprovalRequest(did, shortWait(1_000, LIMIT));
    expect(delegation.delegationCid).toBeDefined();
    expect(discoverCalls).toBe(1);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
  }, 20_000);

  test("(2) a PENDING answer after 1.5 s with --timeout 1s: exit 8 with the pending JSON as soon as that check completes, no second poll, no wait for the request limit", async () => {
    const created = await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    const link = (created.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl;
    onRequest = answerAfter(SLOW);
    const started = Date.now();
    const error = await pendingOf(() => acquireApprovalRequest(did, shortWait(1_000, LIMIT)));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(error.exitCode).toBe(8);
    expect((error.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl).toBe(link);
    expect(discoverCalls).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SLOW - 100);
    expect(Date.now() - started).toBeLessThan(SLOW + 4_000);
    expect(await entries()).toHaveLength(1);
  });

  test("(3) a status request that never answers ends with the OpenKey/network error (exit 6) at the request limit, not as exit 8, and the request stays saved", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    onRequest = answerAfter(Infinity);
    const started = Date.now();
    const error = await pendingOf(() => acquireApprovalRequest(did, shortWait(1_000, 1_500)));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.exitCode).toBe(6);
    expect(error.metadata?.pending).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(await entries()).toHaveLength(1);
  }, 20_000);

  test("(4) --timeout 5s and 60s behave as before: polls every 2 s with a last poll at the deadline; an approval at 6 s is collected", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    discoverCalls = 0; sleeps = []; clock = START;
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(5_000)));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(sleeps).toEqual([2000, 2000, 1000]);
    expect(discoverCalls).toBe(4);
    sleeps = []; clock = START;
    onTick = async (now) => { if (now === START + 6_000) await approve(); };
    const delegation = await acquireApprovalRequest(did, withDeadline(60_000));
    expect(clock).toBe(START + 6_000);
    expect(sleeps.every((ms) => ms <= 2000)).toBe(true);
    expect(delegation.delegationCid).toBeDefined();
  });

  test("(5) two approvals under --timeout 1s: the first check of each one completes", async () => {
    for (const step of [1, 2]) {
      await rm(pendingPath(), { force: true });
      await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000, { step, of: 2 })));
      await approve();
      discoverCalls = 0; clock = START;
      onRequest = answerAfter(SLOW);
      const delegation = await acquireApprovalRequest(did, options({ deadlineMs: START + 1_000, step, of: 2, requestTimeoutMs: LIMIT } as { deadlineMs: number }));
      expect(delegation.delegationCid).toBeDefined();
      expect(discoverCalls).toBe(1);
      await commitAndAcknowledge(delegation);
      onRequest = () => undefined;
    }
    expect(acks).toHaveLength(2);
  }, 20_000);

  test("(6) an entry that already holds a result reference (OpenKey accepted the approval) keeps the old outcome when its status call never answers: exit 8 APPROVAL_RESULT_UNAVAILABLE within timeout + grace, not exit 6", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    await approve();
    const [saved] = await entries();
    await writeJsonDurable(pendingPath(), [{ ...saved!, resultRef: "r".repeat(40), resultExpiresAt: new Date(Date.now() + 600_000).toISOString() }]);
    onRequest = answerAfter(Infinity);
    const started = Date.now();
    // `requestTimeoutMs` 8 s: the first-check branch, if it applied here, would only end at 8 s with exit 6.
    const error = await pendingOf(() => acquireApprovalRequest(did, options({ deadlineMs: Date.now() + 1_000, graceMs: 1_500, requestTimeoutMs: 8_000 } as { deadlineMs: number }, { now: undefined, sleep: undefined })));
    expect(error.code).toBe("APPROVAL_RESULT_UNAVAILABLE");
    expect(error.exitCode).toBe(8);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - started).toBeLessThan(6_500);
    expect((await entries())[0]!.resultRef).toBeDefined();
  }, 20_000);

  test("(7) the exit-6 error carries no hint about the TinyCloud node profile (it is about OpenKey), only that the saved request resumes", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    onRequest = answerAfter(Infinity);
    const error = await pendingOf(() => acquireApprovalRequest(did, shortWait(1_000, 1_500)));
    expect(error.exitCode).toBe(6);
    const printed: string[] = [];
    const write = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { printed.push(String(chunk)); return true; }) as never);
    const exit = spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as never);
    try { try { await handleError(error); } catch (caught) { if ((caught as Error).message !== "exit") throw caught; } } finally { write.mockRestore(); exit.mockRestore(); }
    const text = printed.join("");
    expect(text).toContain("NETWORK_ERROR");
    expect(text).toContain("OpenKey did not answer");
    expect(text).not.toContain("Active profile");
    expect(text).not.toContain("Switch to a reachable profile");
  }, 20_000);
});
