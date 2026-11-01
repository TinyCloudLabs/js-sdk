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

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR", "TC_LINKS_API_ORIGIN"] as const;
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
const { readJson } = await import("../config/storage.js");
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
const fixtureEnvironmentWithLinks = { ...fixtureEnvironment, TC_LINKS_API_ORIGIN: server.url.origin };

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
let offered: string[] = [];
const send = globalThis.fetch;
let fetchSpy: Mock<typeof fetch> | undefined;

function options(wait?: { deadlineMs: number; step?: number; of?: number }) {
  return {
    profileName: "approval", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
    openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
    onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => { offered.push(approvalUrl); },
    ...(wait ? { approvalWait: { step: 1, of: 1, ...wait, now: virtual.now, sleep: virtual.sleep } } : {}),
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
  Object.assign(process.env, fixtureEnvironmentWithLinks);
  results.clear(); linkPosts = 0; discoverCalls = 0; fetchCalls = 0; acks = []; ackSeenSaved = []; expireRequests = false;
  clock = START; sleeps = []; onTick = () => undefined; networkFault = () => false; offered = [];
  await rm(pendingPath(), { force: true });
  await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey("approval", key);
  await ProfileManager.clearSession("approval");
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== server.url.origin) throw new Error("Only the owned fixture may receive requests");
    if (networkFault(url)) return Promise.reject(new TypeError("fetch failed"));
    return send(input, init);
  }, { preconnect: send.preconnect }));
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
    expect(error.metadata).toEqual({ pending: { step: 2, of: 2, approvalUrl: saved[0]!.approvalUrl, expiresAt: saved[0]!.requestExpiresAt } });
    expect(offered).toEqual([saved[0]!.approvalUrl]);
    expect(saved[0]!.approvalUrl).toContain("/a/" + saved[0]!.requestId);
    expect(new Date(saved[0]!.requestExpiresAt).toISOString()).toBe(saved[0]!.requestExpiresAt);
    expect(discoverCalls).toBe(0);
    expect(sleeps).toEqual([]);
    expect(linkPosts).toBe(1);
  });

  test("without a deadline the same call does not return early and behaves as before", async () => {
    const send2 = globalThis.fetch;
    // The owner is already approving: the first poll finds the result.
    onTick = () => undefined;
    const approver = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/result") && !results.size) await approve();
      return send2(input, init);
    }, { preconnect: send2.preconnect }));
    try {
      const delegation = await acquireApprovalRequest(did, options());
      expect(delegation.delegationCid).toBeDefined();
      expect(discoverCalls).toBe(1);
      expect(linkPosts).toBe(1);
      expect(sleeps).toEqual([]);
    } finally { approver.mockRestore(); }
  });
});

describe("a RESUMED request keeps waiting until the deadline", () => {
  test("polls every 2 s, does a final poll exactly at the deadline, then reports the same link", async () => {
    const first = await pendingOf(() => acquireApprovalRequest(did, withDeadline(30_000)));
    const link = (first.metadata as { pending: { approvalUrl: string } }).pending.approvalUrl;
    const before = await entries();
    expect(discoverCalls).toBe(0);

    const second = await pendingOf(() => acquireApprovalRequest(did, withDeadline(30_000, { step: 1, of: 2 })));
    expect(second.exitCode).toBe(8);
    expect(second.code).toBe("APPROVAL_PENDING");
    expect(second.metadata).toEqual({ pending: { step: 1, of: 2, approvalUrl: link, expiresAt: before[0]!.requestExpiresAt } });
    expect(linkPosts).toBe(1);
    expect(offered).toEqual([link, link]);
    expect(sleeps.every((ms) => ms <= 2000)).toBe(true);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
    expect(clock).toBe(START + 30_000);
    expect(discoverCalls).toBe(16);
    expect(await entries()).toEqual(before);
  });

  test("a deadline that is not a multiple of the poll interval still ends exactly on it, after a last poll", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    discoverCalls = 0; sleeps = []; clock = START;
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(5_000)));
    expect(sleeps).toEqual([2000, 2000, 1000]);
    expect(discoverCalls).toBe(4);
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
    expect(clock).toBe(START + 8_000);
    expect(linkPosts).toBe(1);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(new Set(acks.map((ack) => ack.ackId)).size).toBe(1);
    expect(ackSeenSaved).toEqual([{ committed: true, envelopeOnDisk: true, sessionOnDisk: true }]);
    expect(await entries()).toEqual([]);
  });

  test("approval landing exactly on the deadline tick is collected, not lost to exit 8", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    onTick = async (now) => { if (now === START + 10_000) await approve(); };
    const delegation = await acquireApprovalRequest(did, withDeadline(10_000));
    expect(clock).toBe(START + 10_000);
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
    expect(kept[0]!.committed).toBeUndefined();
    await approve();
    clock = START + 10_000; sleeps = [];
    const delegation = await acquireApprovalRequest(did, { ...withDeadline(60_000), onApprovalRequest: ({ approvalUrl }: { approvalUrl: string }) => { expect(approvalUrl).toBe(link); } });
    expect(linkPosts).toBe(1);
    await commitAndAcknowledge(delegation);
    expect(acks).toHaveLength(1);
    expect(await entries()).toEqual([]);
  });

  test("OpenKey network errors during the wait end at the deadline as pending, not as a hang or another error", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    networkFault = (url) => url.pathname.endsWith("/result");
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(7_000)));
    expect(error.code).toBe("APPROVAL_PENDING");
    expect(error.exitCode).toBe(8);
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

  test("a result that cannot be fetched for longer than the grace ends as the existing exit 8 'result unavailable', not as a pending approval, and resumes later", async () => {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    await approve();
    networkFault = (url) => url.pathname.endsWith("/fetch");
    const error = await pendingOf(() => acquireApprovalRequest(did, withDeadline(10_000)));
    expect(error.code).toBe("APPROVAL_RESULT_UNAVAILABLE");
    expect(error.exitCode).toBe(8);
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

// A kill is modeled by an error that nothing in the flow catches; the next call
// starts from the profile directory alone. OpenKey keeps its result 600 s.
describe("a process killed at any seam resumes from local state: exit-0 completion, one request, one ack", () => {
  const KILLED = new Error("process killed");

  async function createApprovedRequest(): Promise<void> {
    await pendingOf(() => acquireApprovalRequest(did, withDeadline(60_000)));
    await approve();
  }
  async function finishAfterKill(expectedRequestPosts = 1): Promise<void> {
    const delegation = await acquireApprovalRequest(did, withDeadline(60_000));
    await commitAndAcknowledge(delegation);
    expect(linkPosts).toBe(expectedRequestPosts);
    expect(acks).toHaveLength(1);
    expect(new Set(acks.map((ack) => ack.ackId)).size).toBe(1);
    expect(await entries()).toEqual([]);
    expect((await ProfileManager.getSession("approval"))?.delegationCid).toBe(delegation.delegationCid);
  }
  function killWhen(match: (url: URL) => boolean, effect: "before-response" | "after-body") {
    let fired = false;
    fetchSpy!.mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (fired || !match(url)) return send(input, init);
      fired = true;
      if (effect === "before-response") throw KILLED;
      const response = await send(input, init);
      await response.clone().text();
      Object.defineProperty(response, "json", { value: async () => { throw KILLED; } });
      return response;
    }, { preconnect: send.preconnect }));
  }

  test("after the poll succeeded, before the result was fetched", async () => {
    await createApprovedRequest();
    killWhen((url) => url.pathname.endsWith("/result"), "after-body");
    await expect(acquireApprovalRequest(did, withDeadline(60_000))).rejects.toBe(KILLED);
    expect(acks).toHaveLength(0);
    fetchSpy!.mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => send(input, init), { preconnect: send.preconnect }));
    await finishAfterKill();
  });

  test("after the result was fetched, before it was saved", async () => {
    await createApprovedRequest();
    killWhen((url) => url.pathname.endsWith("/fetch"), "after-body");
    await expect(acquireApprovalRequest(did, withDeadline(60_000))).rejects.toBe(KILLED);
    expect(acks).toHaveLength(0);
    expect((await entries())[0]!.resultEnvelope).toBeUndefined();
    fetchSpy!.mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => send(input, init), { preconnect: send.preconnect }));
    await finishAfterKill();
  });

  test("after the result was saved, before the login was committed: the next run needs no network to get it back", async () => {
    await createApprovedRequest();
    const delegation = await acquireApprovalRequest(did, withDeadline(60_000));
    const saved = (await entries())[0]!;
    // Saved before commit or ack: the envelope and its OpenKey reference are on disk, fsynced by the durable write.
    expect(saved.resultEnvelope).toBeDefined();
    expect(saved.resultRef).toBeDefined();
    expect(saved.committed).toBeUndefined();
    expect(await ProfileManager.getSession("approval")).toBeNull();
    expect(acks).toHaveLength(0);
    expect(delegation.delegationCid).toBeDefined();
    // Killed here. The retention window at OpenKey may be over: any call to it now fails.
    const discoverBefore = discoverCalls, fetchBefore = fetchCalls;
    networkFault = (url) => url.pathname !== "/v1/links" && !url.pathname.endsWith("/ack");
    const recovered = await acquireApprovalRequest(did, withDeadline(60_000));
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
    const delegation = await acquireApprovalRequest(did, withDeadline(60_000));
    const snapshot = await readProfileSnapshot("approval");
    const verified = verifyScopedLogin(delegation, key, did, requested, { expectedOwner: ownerDid, exactApproval: true });
    await commitLogin("approval", snapshot, { key, session: verified.session, profile: { ...snapshot.profile!, spaceId }, durable: true });
    expect(acks).toHaveLength(0);
    // The next process is the next command: a resumed `onboard` / `auth grant` first completes the saved result.
    networkFault = (url) => url.pathname !== "/v1/links" && !url.pathname.endsWith("/ack");
    await completeApprovalResult("approval");
    expect(acks).toHaveLength(1);
    expect(ackSeenSaved).toEqual([{ committed: true, envelopeOnDisk: true, sessionOnDisk: true }]);
    expect(discoverCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(await entries()).toEqual([]);
    expect(linkPosts).toBe(1);
  });

  test("while the ack is in flight and its reply is lost: the retry repeats the same ack id, one acknowledgement in total", async () => {
    await createApprovedRequest();
    const delegation = await acquireApprovalRequest(did, withDeadline(60_000));
    killWhen((url) => url.pathname.endsWith("/ack"), "after-body");
    await expect(commitAndAcknowledge(delegation)).rejects.toBeInstanceOf(CLIError);
    expect(acks).toHaveLength(1);
    fetchSpy!.mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => send(input, init), { preconnect: send.preconnect }));
    await completeApprovalResult("approval");
    expect(new Set(acks.map((ack) => ack.ackId)).size).toBe(1);
    expect(new Set(acks.map((ack) => ack.resultRef)).size).toBe(1);
    expect(await entries()).toEqual([]);
    expect(linkPosts).toBe(1);
  });
});
