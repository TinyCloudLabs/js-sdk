import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createCipheriv, createECDH, createHash, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { checkLinkRecord, DEFAULT_LINKS_API_ORIGIN, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";

import { requestInvitationApproval, type InvitationApprovalOutcome, type InvitationApprovalRequest } from "./invitation-approval.js";
import { assertApprovalRequestBinding, parseApprovalSiwe } from "./invitation-key-grant.js";

const envKeys = ["TC_OPENKEY_HOST", "TC_OPENKEY_API_HOST", "TC_LINKS_API_ORIGIN"] as const;
const savedEnv = Object.fromEntries(envKeys.map((name) => [name, process.env[name]]));

// Real identities: the owner is a did:pkh wallet, the profile's session is a did:key. They are never the same string.
const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const otherKey = JSON.parse(manager.jwk(manager.createSessionKey("other"))!) as Ed25519PrivateJwk;
const wallet = new PrivateKeySigner(randomBytes(32).toString("hex"));
const address = await wallet.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const stranger = new PrivateKeySigner(randomBytes(32).toString("hex"));
const strangerAddress = await stranger.getAddress();
const network = `urn:tinycloud:encryption:${ownerDid}:default`;
const host = "https://node.example";
const OPENKEY = "https://openkey.example";
const KEY_ID = "d4".repeat(16);
const resultRef = "synthetic-result-reference-123456";
const pair = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
type Mode = "good" | "extra-authority" | "two-keys" | "other-holder" | "too-long" | "no-binding" | "wrong-binding" | "inner-digest" | "inner-id" | "other-owner"
  | "replace-request-id-2" | "replace-request-id-4" | "replace-issued-at-2" | "replace-issued-at-4";
let mode: Mode = "good";
/** Whether the owner has approved: until then OpenKey answers 202 to a discover. */
let approved = true;
/** What OpenKey answers a discover with instead of its normal reply. */
let discoverFailure: { status: number; code: string } | undefined;
let linkPosts = 0;
let requestId = "";
/** The request OpenKey is answering for: the one whose result was last discovered. */
let answeringId = "";
/** The clock the links service holds a new request to; a test that moves the caller's clock moves this too. */
let linkNow: number | undefined;
const acknowledgements: string[] = [];
const resultExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
const activations: string[] = [];
let delegateDown = false;
/** Runs when the node's activation endpoint is called: lets a test act while an approved key is being installed. */
let onActivation: (() => Promise<void>) | undefined;

const root = await mkdtemp(join(tmpdir(), "tc-invitation-approval-"));
const profileDirectory = join(root, ".tinycloud", "profiles", "approval");
const pendingFile = join(profileDirectory, "invitation-approval-pending.json");
interface StoredEntry {
  request: { resultEncryptionPublicJwk: { x: string; y: string }; permissions: unknown[]; context: { recipientEmail: string; accessExpiresAt: string; acceptanceExpiresAt: string } };
  bodyCid: string; requestId: string; requestExpiresAt: string; resultExpiresAt?: string; resultEnvelope?: unknown; approvalUrl: string;
}
const readEntries = async (): Promise<StoredEntry[]> => JSON.parse(await readFile(pendingFile, "utf8")) as StoredEntry[];

/** The approver: what OpenKey signs for one invitation request (a raw key grant with the Request ID field), sealed to the request's own result key. */
async function resultFor(entry: StoredEntry) {
  const rawAbilities: Record<string, string[]> = { [`${network}/share/${KEY_ID}`]: pair };
  if (mode === "extra-authority") rawAbilities[network] = ["tinycloud.encryption/decrypt"];
  if (mode === "two-keys") rawAbilities[`${network}/share/${"e5".repeat(16)}`] = pair;
  const holder = mode === "other-holder" ? otherKey : key;
  const signer = mode === "other-owner" ? stranger : wallet;
  const signerAddress = mode === "other-owner" ? strangerAddress : address;
  const prepared = wasm.prepareSession({ abilities: {}, rawAbilities, address: signerAddress, chainId: 1, domain: "openkey.example", spaceId: wasm.makeSpaceId(signerAddress, 1, "default"), jwk: holder,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + (mode === "too-long" ? 3 * 86_400_000 : 3_000_000)).toISOString() });
  let siwe = prepared.siwe;
  const binding = mode === "no-binding" || mode.startsWith("replace-request-id") ? undefined
    : mode === "wrong-binding" ? `Request ID: urn:tinycloud:approval-request:${"z".repeat(26)}:${entry.bodyCid}`
      : `Request ID: urn:tinycloud:approval-request:${entry.requestId}:${entry.bodyCid}`;
  if (binding !== undefined) siwe = siwe.replace(/\nResources:/, `\n${binding}\nResources:`);
  // The owner signs the CANONICAL message (without a Request ID for the request-id attacks; with a proper Issued At for the time attacks) and the
  // session is completed from that signature. Only afterwards is the raw text handed to the caller altered: a blank line 2 or 4 REPLACED by a
  // Request ID or an Issued At line, keeping the original signature, delegation header and CID. The strict parse must refuse the altered text.
  const signature = await signer.signMessage(siwe);
  const session = wasm.completeSessionSetup({ ...prepared, siwe, signature });
  let delivered = siwe;
  if (mode.startsWith("replace-")) {
    const index = mode.endsWith("-2") ? 2 : 4;
    const replacement = mode.startsWith("replace-request-id") ? `Request ID: urn:tinycloud:approval-request:${entry.requestId}:${entry.bodyCid}` : `Issued At: ${new Date(Date.now() - 864_000_000).toISOString()}`;
    // Baseline: the canonical message the owner really signed parses strictly; only the delivered raw text below is altered.
    expect(() => parseApprovalSiwe(siwe)).not.toThrow();
    expect(siwe.split("\n")[index]).toBe("");
    delivered = siwe.split("\n").map((row: string, at: number) => (at === index ? replacement : row)).join("\n");
    expect(delivered).not.toBe(siwe);
  }
  const delegation = { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did, address: signerAddress, chainId: 1,
    spaceId: wasm.makeSpaceId(signerAddress, 1, "default"), ownerDid: `did:pkh:eip155:1:${signerAddress}`, siwe: delivered, signature };
  const recipient = entry.request.resultEncryptionPublicJwk;
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(entry.requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(entry.requestId));
  const delegationExpiresAt = new Date((siwe.match(/^Expiration Time:\s*(.+)$/m))![1]!).toISOString();
  const body = { resultVersion: 1, requestId: mode === "inner-id" ? "z".repeat(26) : entry.requestId, requestDigest: mode === "inner-digest" ? "bafy-another-request" : entry.bodyCid,
    requesterDid: did, ownerDid: `did:pkh:eip155:1:${signerAddress}`, targetDid: did, delegationExpiresAt, delegation };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const point = ephemeral.getPublicKey();
  const ephemeralPublicJwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") };
  return { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

/** The links service and OpenKey, as one fetch. Nothing else is reachable through it. */
async function serveOpenKey(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const url = new URL(request.url);
  if (url.origin === DEFAULT_LINKS_API_ORIGIN && url.pathname === "/v1/links") {
    const checked = await checkLinkRecord(await request.json(), linkNow ?? Date.now());
    linkPosts += 1;
    requestId = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    return Response.json({ id: requestId, expiresAt: checked.header.expiresAt }, { status: 201 });
  }
  if (url.origin !== OPENKEY) throw new Error(`Only the fixture may receive requests: ${url.origin}`);
  const body = await request.json() as { bodyCid: string; ackId?: string };
  const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
  if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) return new Response(null, { status: 401 });
  const discoveredId = /^\/api\/approval-requests\/([^/]+)\/result$/.exec(url.pathname)?.[1];
  if (discoveredId) answeringId = discoveredId;
  const action = url.pathname.endsWith("/result") ? "discover" : url.pathname.endsWith("/fetch") ? "fetch" : "ack";
  const credential = JSON.stringify([action, answeringId, body.bodyCid, action === "discover" ? "" : resultRef, action === "ack" ? body.ackId : ""]);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  if (claims.cred_hash !== createHash("sha256").update(credential).digest("base64url")) return new Response(null, { status: 401 });
  if (action === "discover") {
    if (discoverFailure) return Response.json({ code: discoverFailure.code }, { status: discoverFailure.status });
    return approved ? Response.json({ resultRef, expiresAt: resultExpiresAt }) : new Response(null, { status: 202 });
  }
  if (action === "fetch") {
    const entries = await readEntries();
    const entry = entries.find((item) => item.requestId === answeringId);
    return Response.json({ requestId: answeringId, bodyCid: body.bodyCid, resultRef, expiresAt: resultExpiresAt, relay: await resultFor(entry!) });
  }
  acknowledgements.push(body.ackId!);
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
}
const openKeyFetch: typeof fetch = Object.assign(serveOpenKey, { preconnect: globalThis.fetch.preconnect });

const hour = () => new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000);
let node: TinyCloudNode;
const ask = (overrides: Partial<InvitationApprovalRequest> = {}): Promise<InvitationApprovalOutcome> => requestInvitationApproval({
  stateRoot: root, profile: "approval", node, ownerDid, recipientEmail: "reader@example.com", subjectName: "note.md", subjectKind: "file",
  accessExpiresAt: hour(), openkeyHost: OPENKEY, ...overrides,
}, { fetch: openKeyFetch });
async function askPending(overrides: Partial<InvitationApprovalRequest> = {}) {
  const outcome = await ask(overrides);
  if (outcome.status !== "pending") throw new Error("expected a pending approval");
  return outcome;
}
async function askApproved(overrides: Partial<InvitationApprovalRequest> = {}) {
  const outcome = await ask(overrides);
  if (outcome.status !== "approved") throw new Error("expected an approved invitation");
  return outcome;
}
const refusal = (code: string) => ({ operationError: { code } });

async function realSessionNode(): Promise<TinyCloudNode> {
  const issued = new Date();
  const spaceId = wasm.makeSpaceId(address, 1, "applications");
  const prepared = wasm.prepareSession({ abilities: { kv: { "": ["tinycloud.kv/list"] } }, address, chainId: 1, domain: "cli.example", spaceId, jwk: key,
    issuedAt: new Date(issued.getTime() - 1000).toISOString(), expirationTime: new Date(issued.getTime() + 3_600_000).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const created = new TinyCloudNode({ host, tinycloudFallbackHosts: [host], autoDiscoverLocalNode: false, enablePublicSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false });
  await created.restoreSession({ delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, jwk: key, verificationMethod: did, address, chainId: 1,
    siwe: prepared.siwe, signature, expiresAt: new Date(issued.getTime() + 3_600_000).toISOString(), tinycloudHosts: [host] });
  return new Proxy(created, { get(target, property) {
    if (property === "activeNodeIdentity") return async () => ({ origin: host, nodeDid: "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2" });
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

let localOnly: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  for (const name of envKeys) delete process.env[name];
  const send = globalThis.fetch;
  localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // The node's activation endpoint and location registry are answered locally; nothing else leaves the process.
    if (url.origin === host && url.pathname === "/delegate") {
      if (delegateDown) throw new TypeError("fetch failed");
      activations.push(url.pathname);
      await onActivation?.();
      return Response.json({ activated: true });
    }
    if (url.origin === "https://registry.tinycloud.xyz" && /^\/v[12]\/locations\//.test(url.pathname)) {
      return new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Only the local fixture may receive requests: ${url.origin}`);
  }, { preconnect: send.preconnect }));
  mode = "good"; approved = true; discoverFailure = undefined; delegateDown = false; onActivation = undefined;
  linkPosts = 0; answeringId = ""; linkNow = undefined; acknowledgements.length = 0; activations.length = 0;
  await rm(profileDirectory, { recursive: true, force: true });
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(profileDirectory, "profile.json"), JSON.stringify({ name: "approval" }));
  node = await realSessionNode();
});
afterEach(() => {
  localOnly?.mockRestore();
  for (const name of envKeys) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const installedKeys = () => node.getRuntimePermissionDelegations().flatMap((delegation) => delegation.resources ?? []).filter((resource) => resource.path.includes("/share/"));

test("the first call creates the request, returns its link without waiting, and keeps it in an owner-only file keyed by request", async () => {
  const outcome = await askPending();
  expect(linkPosts).toBe(1);
  expect(outcome.requestId).toBe(requestId);
  expect(outcome.approvalUrl.startsWith(OPENKEY)).toBe(true);
  expect(Date.parse(outcome.expiresAt)).toBeGreaterThan(Date.now());
  expect(acknowledgements).toEqual([]);
  expect((await stat(pendingFile)).mode & 0o777).toBe(0o600);
  const entries = await readEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]!.requestId).toBe(outcome.requestId);
  expect(entries[0]!.approvalUrl).toBe(outcome.approvalUrl);
  // An invitation request names no permissions and no key; its context is what the owner was shown.
  expect(entries[0]!.request.permissions).toEqual([]);
  expect(entries[0]!.request.context.recipientEmail).toBe("reader@example.com");
  expect(entries[0]!.resultEnvelope).toBeUndefined();
  // The session's private key is never written to the pending file.
  expect(await readFile(pendingFile, "utf8")).not.toContain(key.d);
  expect(installedKeys()).toEqual([]);
});

test("the owner approves between two calls: the second verifies, installs exactly one key, takes the approval once and acknowledges it", async () => {
  approved = false;
  const first = await askPending();
  const again = await askPending();
  // Until approved, asking again returns the same request and its link, and makes no new request.
  expect(again).toEqual(first);
  expect(linkPosts).toBe(1);
  approved = true;
  const access = hour();
  const result = await askApproved({ accessExpiresAt: access });
  expect(result).toEqual({ status: "approved", shareId: KEY_ID, accessExpiresAt: access.toISOString(), resumed: false });
  const installed = installedKeys();
  expect(installed.map((resource) => resource.path)).toEqual([`${network}/share/${KEY_ID}`]);
  expect([...installed[0]!.actions].sort()).toEqual([...pair].sort());
  expect(node.getVerifiedSessionCapabilities().some((entry) => entry.service === "tinycloud.encryption")).toBe(false);
  expect(acknowledgements).toHaveLength(1);
  expect(await readEntries()).toEqual([]);
  // Single use: the approval is gone, so the next call is a new request.
  expect((await askPending()).requestId).not.toBe(first.requestId);
  expect(linkPosts).toBe(2);
});

test("a changed recipient, subject kind, file name, file content or expiry is a new request, each kept under its own request id", async () => {
  approved = false;
  const base = hour();
  const first = await askPending({ accessExpiresAt: base, contentSha256: "sha-one" });
  const different: Array<Partial<InvitationApprovalRequest>> = [
    { recipientEmail: "other@example.com" }, { subjectKind: "session" }, { subjectName: "other.md" }, { contentSha256: "sha-two" },
    { accessExpiresAt: new Date(base.getTime() + 1000) },
  ];
  const ids = [first.requestId];
  for (const change of different) ids.push((await askPending({ accessExpiresAt: base, contentSha256: "sha-one", ...change })).requestId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(linkPosts).toBe(ids.length);
  expect((await readEntries()).map((entry) => entry.requestId).sort()).toEqual([...ids].sort());
  // The first is still the one an identical call continues.
  expect((await askPending({ accessExpiresAt: base, contentSha256: "sha-one" })).requestId).toBe(first.requestId);
  expect(linkPosts).toBe(ids.length);
});

test("the same relative choice resumes its open request and absolute date however long the preparation took; another duration, even by 1 s, is a new request", async () => {
  approved = false;
  const DURATION = 7 * 86_400_000;
  const base = Math.floor((Date.now() + DURATION) / 1000) * 1000;
  const ask7d = (accessMs: number, durationMs = DURATION, sha = "sha-one", email = "reader@example.com") =>
    ask({ accessExpiresAt: new Date(accessMs), contentSha256: sha, requestedDurationMs: durationMs, recipientEmail: email });
  const first = await askPending({ accessExpiresAt: new Date(base), contentSha256: "sha-one", requestedDurationMs: DURATION });
  // The same duration resumes whether the rerun's clock moved by 3 s or by 90 s: no timing is inferred.
  for (const delay of [3_000, 90_000]) {
    expect(await ask7d(base + delay)).toEqual(first);
  }
  expect(linkPosts).toBe(1);
  // Another duration (7d + 1 s), another file, another recipient, or no duration with another date is a new request.
  const second = await ask7d(base + 4_000, DURATION + 1_000);
  const third = await ask7d(base + 3_000, DURATION, "sha-two");
  const fourth = await ask7d(base + 3_000, DURATION, "sha-one", "other@example.com");
  const fifth = await ask({ accessExpiresAt: new Date(base + 3_000), contentSha256: "sha-one" });
  expect(new Set([first, second, third, fourth, fifth].map((outcome) => (outcome as { requestId: string }).requestId)).size).toBe(5);
  // A pending date that is not earlier than the new request's is not resumed.
  const earlier = await ask7d(base - 5_000);
  expect((earlier as { requestId: string }).requestId).not.toBe(first.requestId);
  // Once approved, the rerun's share is issued with the request's own absolute date.
  approved = true;
  const resumed = await askApproved({ accessExpiresAt: new Date(base + 5_000), contentSha256: "sha-one", requestedDurationMs: DURATION });
  expect(resumed).toMatchObject({ shareId: KEY_ID, accessExpiresAt: new Date(base).toISOString(), resumed: true });
});

test("a stored request past its retention is dropped; so is one whose approved result has expired; neither is resumed", async () => {
  approved = false;
  const first = await askPending();
  const stale = await readEntries();
  stale[0]!.requestExpiresAt = new Date(Date.now() - 86_400_000).toISOString();
  stale[0]!.request.context.acceptanceExpiresAt = stale[0]!.requestExpiresAt;
  await writeFile(pendingFile, JSON.stringify(stale));
  const second = await askPending();
  expect(second.requestId).not.toBe(first.requestId);
  expect((await readEntries()).map((entry) => entry.requestId)).toEqual([second.requestId]);
  // An approved result that could not be installed is kept until its own expiry, then dropped.
  approved = true;
  delegateDown = true;
  await expect(ask()).rejects.toMatchObject(refusal("NODE_UNREACHABLE"));
  const held = await readEntries();
  expect(held[0]!.resultEnvelope).toBeDefined();
  held[0]!.resultExpiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(pendingFile, JSON.stringify(held));
  approved = false;
  const third = await askPending();
  expect(third.requestId).not.toBe(second.requestId);
  expect((await readEntries()).map((entry) => entry.requestId)).toEqual([third.requestId]);
  expect(linkPosts).toBe(3);
});

test("a host that cannot be reached keeps the approved request pending (not taken); the next call installs the same approval", async () => {
  const access = hour();
  await askPending({ accessExpiresAt: access });
  delegateDown = true;
  await expect(ask({ accessExpiresAt: access })).rejects.toMatchObject({ operationError: { code: "NODE_UNREACHABLE", retryable: true } });
  expect(acknowledgements).toEqual([]);
  expect(await readEntries()).toHaveLength(1);
  expect(node.getRuntimePermissionDelegations()).toEqual([]);
  expect(linkPosts).toBe(1);
  delegateDown = false;
  expect(await askApproved({ accessExpiresAt: access })).toMatchObject({ shareId: KEY_ID });
  expect(linkPosts).toBe(1);
  expect(acknowledgements).toHaveLength(1);
  expect(await readEntries()).toEqual([]);
});

test("an approval used by another process while it was being installed is refused as already used and is not acknowledged", async () => {
  await askPending();
  onActivation = async () => { await writeFile(pendingFile, "[]"); };
  await expect(ask()).rejects.toMatchObject({ operationError: { code: "APPROVAL_RESULT_INVALID", message: expect.stringMatching(/already used/) } });
  expect(acknowledgements).toEqual([]);
});

test("OpenKey saying the request is unknown or expired ends it: the entry is dropped and the next call makes a new request", async () => {
  const first = await askPending();
  discoverFailure = { status: 404, code: "not_found" };
  await expect(ask()).rejects.toMatchObject(refusal("APPROVAL_REQUEST_EXPIRED"));
  expect(await readEntries()).toEqual([]);
  discoverFailure = undefined;
  approved = false;
  expect((await askPending()).requestId).not.toBe(first.requestId);
  // An answer that is not a verdict on the request leaves it saved, as retryable.
  discoverFailure = { status: 500, code: "server_error" };
  await expect(ask()).rejects.toMatchObject({ operationError: { code: "APPROVAL_UNAVAILABLE", retryable: true } });
  expect(await readEntries()).toHaveLength(1);
});

test.each<Mode>([
  "extra-authority", "two-keys", "too-long", "no-binding", "wrong-binding", "other-owner", "other-holder",
  // A correctly owner-signed result whose OWN relay binding is wrong: refused by the relay checks alone, not masked by the signed binding.
  "inner-digest", "inner-id",
  // The REAL wallet signature over a text with a blank line replaced by a Request ID / Issued At line: the strict parse refuses it.
  "replace-request-id-2", "replace-request-id-4", "replace-issued-at-2", "replace-issued-at-4",
])("a result that is %s is refused before anything is installed or acknowledged, and its request is dropped", async (bad) => {
  await askPending();
  mode = bad;
  const refused = ask();
  await expect(refused).rejects.toMatchObject(refusal("APPROVAL_RESULT_INVALID"));
  if (bad.startsWith("replace-")) {
    // The refusal is the caller's own strict parse of the altered raw text, not a signature failure in the verifier that would only mask it.
    await expect(refused).rejects.toMatchObject({ message: expect.stringMatching(/not a valid sign-in message|canonical form/) });
  }
  expect(node.getRuntimePermissionDelegations()).toEqual([]);
  expect(acknowledgements).toEqual([]);
  expect(activations).toEqual([]);
  expect(await readEntries()).toEqual([]);
});

test("a profile that records no owner account is refused before anything is asked of OpenKey", async () => {
  await expect(ask({ ownerDid: "" })).rejects.toMatchObject(refusal("INPUT_INVALID"));
  await expect(ask({ ownerDid: key.x })).rejects.toMatchObject(refusal("INPUT_INVALID"));
  expect(linkPosts).toBe(0);
});

test("an access date that is already past is refused and nothing is created", async () => {
  await expect(ask({ accessExpiresAt: new Date(Date.now() - 60_000) })).rejects.toMatchObject(refusal("INPUT_INVALID"));
  expect(linkPosts).toBe(0);
});

// ---- the request binding, from one strict parse of real owner-signed texts -----------------------------------------------------

async function signedText(bind: boolean): Promise<string> {
  const prepared = wasm.prepareSession({ abilities: {}, rawAbilities: { [`${network}/share/${KEY_ID}`]: pair }, address, chainId: 1, domain: "openkey.example", spaceId: wasm.makeSpaceId(address, 1, "default"), jwk: key,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + 3_000_000).toISOString() });
  return bind ? prepared.siwe.replace(/\nResources:/, `\nRequest ID: ${line}\nResources:`) : prepared.siwe;
}
// The owner really signs the replaced text: the signer accepts it, so the refusal must come from the verifier's own parse.
async function signedTextFrom(text: string): Promise<string> {
  const signature = await wallet.signMessage(text);
  expect(signature.length).toBeGreaterThan(0);
  return text;
}
const mine = { requestId: "a".repeat(26), bodyCid: "bafy-mine" };
const line = `urn:tinycloud:approval-request:${mine.requestId}:${mine.bodyCid}`;

test("the request binding check accepts only the one Request ID of this request, from one strict parse", async () => {
  const siwe = await signedText(true);
  expect(() => assertApprovalRequestBinding(siwe, mine)).not.toThrow();
  expect(parseApprovalSiwe(siwe).requestId).toBe(line);
  const field = `Request ID: ${line}`;
  for (const bad of [siwe.replace(field, ""), siwe.replace(field, `${field}\n${field}`), siwe.replace(field, `${field} `), siwe.replace(field, field.replace("bafy-mine", "bafy-other")),
    siwe.replace(field, field.replace("a".repeat(26), "b".repeat(26))), siwe.replace(field, field.replace("Request ID", "request id")), siwe.replace(field, `Request ID: ${mine.requestId}:${mine.bodyCid}`)]) {
    expect(() => assertApprovalRequestBinding(bad, mine)).toThrow();
  }
});

test("a Request ID injected where the parser does not read it never binds, and a non-canonical text is refused", async () => {
  const unbound = await signedText(false);
  const rows = unbound.split("\n");
  const inject = (index: number) => [...rows.slice(0, index), `Request ID: ${line}`, ...rows.slice(index)].join("\n");
  for (const text of [inject(1), inject(2), inject(3), inject(5), `${unbound}\nRequest ID: ${line}`]) {
    expect(() => assertApprovalRequestBinding(text, mine)).toThrow();
    expect(() => parseApprovalSiwe(text)).toThrow();
  }
  // The attack shape the signer accepts: the owner really signs the canonical text with a blank line (index 2 or 4) REPLACED by a
  // Request ID or an Issued At line. The binding function, on its own text, refuses it.
  for (const index of [2, 4]) {
    for (const replacement of [`Request ID: ${line}`, `Issued At: ${new Date(Date.now() - 864_000_000).toISOString()}`]) {
      const replaced = rows.map((row, at) => (at === index ? replacement : row)).join("\n");
      const signedReplaced = await signedTextFrom(replaced);
      expect(() => assertApprovalRequestBinding(signedReplaced, mine)).toThrow();
    }
  }
  expect(parseApprovalSiwe(unbound).requestId).toBeUndefined();
  expect(() => assertApprovalRequestBinding(unbound, mine)).toThrow();
  const bound = await signedText(true);
  // The equality branch itself: the parser accepts 'Chain ID: 01' (it reads 1) but re-serialising gives 'Chain ID: 1', not the signed text.
  expect(bound.includes("Chain ID: 1")).toBe(true);
  expect(() => parseApprovalSiwe(bound.replace("Chain ID: 1", "Chain ID: 01"))).toThrow(/canonical form/);
  for (const text of [bound.replace(/\n/g, "\r\n"), `${bound}\n`, ` ${bound}`, bound.replace("Version: 1", "Version:  1")]) {
    expect(() => parseApprovalSiwe(text)).toThrow();
  }
});

test("a request with under a minute left is not resumed", async () => {
  approved = false;
  const DURATION = 7 * 86_400_000;
  const base = Math.floor((Date.now() + DURATION) / 1000) * 1000;
  const overrides = { contentSha256: "sha-one", requestedDurationMs: DURATION };
  const first = await askPending({ ...overrides, accessExpiresAt: new Date(base) });
  linkNow = base - 30_000;
  const late = await requestInvitationApproval({
    stateRoot: root, profile: "approval", node, ownerDid, recipientEmail: "reader@example.com", subjectName: "note.md", subjectKind: "file",
    accessExpiresAt: new Date(base + 3_600_000), openkeyHost: OPENKEY, ...overrides,
  }, { fetch: openKeyFetch, now: () => base - 30_000 }).finally(() => { linkNow = undefined; });
  expect(late).toMatchObject({ status: "pending" });
  expect((late as { requestId: string }).requestId).not.toBe(first.requestId);
});
