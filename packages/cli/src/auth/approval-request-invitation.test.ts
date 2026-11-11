import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createHash, createHmac, createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { checkLinkRecord, signerFromJwk, type Ed25519PrivateJwk, type ShareInvitationApprovalContext } from "@tinycloud/share-envelope/links";

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR"] as const;
const snapshotEnvironment = () => Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
function restoreEnvironment(snapshot: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
const original = snapshotEnvironment();
const home = mkdtempSync("/var/tmp/TC2234-invitation-approval-test-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier"), BUN_INSTALL_CACHE_DIR: join(home, "bun-cache") };
Object.assign(process.env, fixtureEnvironment);
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson } = await import("../config/storage.js");
const { acquireApprovalRequest, pendingInvitationContext, takeInvitationApproval } = await import("./approval-request.js");
const { relayPublicJwkOf } = await import("./device-auth.js");
restoreEnvironment(original);
let caseEnvironment = original;

const wasm = new NodeWasmBindings();
const manager = wasm.createSessionManager();
const key = JSON.parse(manager.jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const otherKey = JSON.parse(manager.jwk(manager.createSessionKey("other"))!) as Ed25519PrivateJwk;
const wallet = new PrivateKeySigner(randomBytes(32).toString("hex"));
const address = await wallet.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const host = "https://node.example";
const KEY_ID = "d4".repeat(16);
const resultRef = "synthetic-result-reference-123456";
const pair = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
type Mode = "good" | "extra-authority" | "two-keys" | "other-holder" | "too-long";
let mode: Mode = "good";
let linkPosts = 0;
let requestId = "";
const acknowledgements: string[] = [];
const resultExpiresAt = new Date(Date.now() + 3_600_000).toISOString();

/** The approver: what OpenKey signs for one invitation request, encrypted to the request's own result key. */
async function resultFor(entry: { request: { resultEncryptionPublicJwk: { x: string; y: string } }; bodyCid: string }) {
  const network = `urn:tinycloud:encryption:${ownerDid}:default`;
  const abilities: Record<string, Record<string, string[]>> = { encryption: { [`${network}/share/${KEY_ID}`]: pair } };
  if (mode === "extra-authority") abilities.kv = { "xyz.tinycloud.courier/me/": ["tinycloud.kv/get"] };
  if (mode === "two-keys") abilities.encryption![`${network}/share/${"e5".repeat(16)}`] = pair;
  const holder = mode === "other-holder" ? otherKey : key;
  const spaceId = wasm.makeSpaceId(address, 1, "default");
  const prepared = wasm.prepareSession({ abilities, address, chainId: 1, domain: "openkey.example", spaceId, jwk: holder,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + (mode === "too-long" ? 3 * 86_400_000 : 3_000_000)).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const delegation = { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did, address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature };
  const recipient = entry.request.resultEncryptionPublicJwk;
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const delegationExpiresAt = new Date((prepared.siwe.match(/^Expiration Time:\s*(.+)$/m))![1]!).toISOString();
  const body = { resultVersion: 1, requestId, requestDigest: entry.bodyCid, requesterDid: did, ownerDid, targetDid: did, delegationExpiresAt, delegation };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral), nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/v1/links") {
    const checked = await checkLinkRecord(await request.json(), Date.now());
    linkPosts += 1;
    requestId = Array.from(randomBytes(26), (byte) => String.fromCharCode(97 + byte % 26)).join("");
    return Response.json({ id: requestId, expiresAt: checked.header.expiresAt }, { status: 201 });
  }
  const body = await request.json() as { bodyCid: string; ackId?: string };
  const [header, payload, signature] = (request.headers.get("OpenKey-Session-Proof") ?? "").split(".");
  if (!header || !payload || !signature || !verify(null, Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" }), Buffer.from(signature, "base64url"))) return new Response(null, { status: 401 });
  const action = url.pathname.endsWith("/result") ? "discover" : url.pathname.endsWith("/fetch") ? "fetch" : "ack";
  const credential = JSON.stringify([action, requestId, body.bodyCid, action === "discover" ? "" : resultRef, action === "ack" ? body.ackId : ""]);
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  if (claims.cred_hash !== createHash("sha256").update(credential).digest("base64url")) return new Response(null, { status: 401 });
  const expiresAt = resultExpiresAt;
  if (action === "discover") return Response.json({ resultRef, expiresAt });
  if (action === "fetch") {
    const [entry] = await readJson<Array<{ request: { resultEncryptionPublicJwk: { x: string; y: string } }; bodyCid: string }>>(join(profilePath("approval"), "approval-pending.json")) ?? [];
    return Response.json({ requestId, bodyCid: body.bodyCid, resultRef, expiresAt, relay: await resultFor(entry!) });
  }
  acknowledgements.push(body.ackId!);
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
} });

const pendingFile = () => join(profilePath("approval"), "approval-pending.json");
const context = (overrides: Partial<ShareInvitationApprovalContext> = {}): ShareInvitationApprovalContext => ({
  kind: "share-invitation", version: 1, invitationId: "01HZX3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3", recipientEmail: "reader@example.com", subjectKind: "file", subjectName: "note.md",
  acceptanceExpiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000).toISOString(),
  accessExpiresAt: new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000).toISOString(), ...overrides,
});
const acquire = (value: ShareInvitationApprovalContext) => acquireApprovalRequest(did, {
  profileName: "approval", jwk: key, host, invitationContext: value, expectedOwner: ownerDid,
  openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true, onApprovalRequest: () => {},
});
let localOnly: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment);
  const send = globalThis.fetch;
  localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") return send(server.url.origin + url.pathname, init);
    if (url.origin !== server.url.origin) throw new Error("Only the local fixture may receive requests");
    return send(input, init);
  }, { preconnect: send.preconnect }));
  mode = "good"; linkPosts = 0; acknowledgements.length = 0;
  await rm(pendingFile(), { force: true });
  await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "default", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey("approval", key);
  await ProfileManager.clearSession("approval");
});
afterEach(async () => {
  localOnly?.mockRestore();
  try { await rm(pendingFile(), { force: true }); } finally { restoreEnvironment(caseEnvironment); }
});
afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

test("an invitation request carries its context and no permissions; the approved grant is read from its signature and can be taken once", async () => {
  const value = context();
  const delegation = await acquire(value);
  const [entry] = (await readJson<Array<{ request: { permissions: unknown[]; context: unknown } }>>(pendingFile()))!;
  expect(entry!.request.permissions).toEqual([]);
  expect(entry!.request.context).toEqual(value);
  expect(typeof delegation.siwe).toBe("string");
  expect(await pendingInvitationContext("approval", { recipientEmail: "reader@example.com", subjectName: "note.md" })).toEqual(value);
  await takeInvitationApproval("approval", delegation);
  expect(acknowledgements).toHaveLength(1);
  expect(await readJson(pendingFile())).toEqual([]);
  // Taken once: the same approval cannot be used again.
  await expect(takeInvitationApproval("approval", delegation)).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
});

test("a rerun with the same invitation continues the open request instead of asking again", async () => {
  const value = context();
  await acquire(value);
  const resumed = await pendingInvitationContext("approval", { recipientEmail: "reader@example.com", subjectName: "note.md" });
  expect(resumed).toEqual(value);
  await acquire(resumed!);
  expect(linkPosts).toBe(1);
  expect(await pendingInvitationContext("approval", { recipientEmail: "other@example.com", subjectName: "note.md" })).toBeUndefined();
});

test.each<[Mode, string]>([
  ["extra-authority", "APPROVAL_RESULT_INVALID"],
  ["two-keys", "APPROVAL_RESULT_INVALID"],
  ["too-long", "APPROVAL_RESULT_INVALID"],
  ["other-holder", "OPENKEY_PROOF_INVALID"],
])("a result that is %s is refused before anything is used", async (bad, code) => {
  mode = bad;
  await expect(acquire(context())).rejects.toMatchObject({ code });
  expect(acknowledgements).toEqual([]);
});
