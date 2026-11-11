import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createHash, createHmac, createECDH, createPublicKey, randomBytes, verify } from "node:crypto";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner, TinyCloudNode } from "@tinycloud/node-sdk";
import { REGISTRY_NOT_FOUND_BODY } from "@tinycloud/sdk-core";
import { checkLinkRecord, signerFromJwk, type Ed25519PrivateJwk, type ShareInvitationApprovalContext } from "@tinycloud/share-envelope/links";

const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME", "BUN_INSTALL_CACHE_DIR", "TC_OPENKEY_API_HOST", "TC_AUTH_NO_POPUP"] as const;
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
const { acquireApprovalRequest, invitationGrantOf, pendingInvitationContext, takeInvitationApproval } = await import("./approval-request.js");
const { assertApprovalRequestBinding, parseApprovalSiwe } = await import("./invitation-key-grant.js");
const { sessionHoldsEncryptionDecrypt } = await import("../share/adapters.js");
const { approveEmailInviteKey } = await import("../share/invite-approval.js");
const { relayPublicJwkOf } = await import("./device-auth.js");
restoreEnvironment(original);
let caseEnvironment = original;

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
const KEY_ID = "d4".repeat(16);
const resultRef = "synthetic-result-reference-123456";
const pair = ["tinycloud.encryption/key.create", "tinycloud.encryption/decrypt"];
type Mode = "good" | "extra-authority" | "two-keys" | "other-holder" | "too-long" | "no-binding" | "wrong-binding" | "inner-digest" | "inner-id" | "other-owner";
let mode: Mode = "good";
let linkPosts = 0;
let requestId = "";
const acknowledgements: string[] = [];
const resultExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
const activations: string[] = [];

/** The approver: what OpenKey signs for one invitation request (a raw key grant with the Request ID field), sealed to the request's own result key. */
async function resultFor(entry: { request: { resultEncryptionPublicJwk: { x: string; y: string } }; bodyCid: string; requestId: string }) {
  const rawAbilities: Record<string, string[]> = { [`${network}/share/${KEY_ID}`]: pair };
  if (mode === "extra-authority") rawAbilities[network] = ["tinycloud.encryption/decrypt"];
  if (mode === "two-keys") rawAbilities[`${network}/share/${"e5".repeat(16)}`] = pair;
  const holder = mode === "other-holder" ? otherKey : key;
  const signer = mode === "other-owner" ? stranger : wallet;
  const signerAddress = mode === "other-owner" ? strangerAddress : address;
  const prepared = wasm.prepareSession({ abilities: {}, rawAbilities, address: signerAddress, chainId: 1, domain: "openkey.example", spaceId: wasm.makeSpaceId(signerAddress, 1, "default"), jwk: holder,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + (mode === "too-long" ? 3 * 86_400_000 : 3_000_000)).toISOString() });
  let siwe = prepared.siwe;
  const binding = mode === "no-binding" ? undefined
    : mode === "wrong-binding" ? `Request ID: urn:tinycloud:approval-request:${"z".repeat(26)}:${entry.bodyCid}`
      : `Request ID: urn:tinycloud:approval-request:${entry.requestId}:${entry.bodyCid}`;
  if (binding !== undefined) siwe = siwe.replace(/\nResources:/, `\n${binding}\nResources:`);
  const signature = await signer.signMessage(siwe);
  const session = wasm.completeSessionSetup({ ...prepared, siwe, signature });
  const delegation = { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did, address: signerAddress, chainId: 1,
    spaceId: wasm.makeSpaceId(signerAddress, 1, "default"), ownerDid: `did:pkh:eip155:1:${signerAddress}`, siwe, signature };
  const recipient = entry.request.resultEncryptionPublicJwk;
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipient.x, "base64url"), Buffer.from(recipient.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const delegationExpiresAt = new Date((siwe.match(/^Expiration Time:\s*(.+)$/m))![1]!).toISOString();
  const body = { resultVersion: 1, requestId: mode === "inner-id" ? "z".repeat(26) : requestId, requestDigest: mode === "inner-digest" ? "bafy-another-request" : entry.bodyCid,
    requesterDid: did, ownerDid: `did:pkh:eip155:1:${signerAddress}`, targetDid: did, delegationExpiresAt, delegation };
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
    const [entry] = await readJson<Array<{ request: { resultEncryptionPublicJwk: { x: string; y: string } }; bodyCid: string; requestId: string }>>(join(profilePath("approval"), "approval-pending.json")) ?? [];
    return Response.json({ requestId, bodyCid: body.bodyCid, resultRef, expiresAt, relay: await resultFor(entry!) });
  }
  acknowledgements.push(body.ackId!);
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
} });

const pendingFile = () => join(profilePath("approval"), "approval-pending.json");
const hour = () => new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000).toISOString();
const context = (overrides: Partial<ShareInvitationApprovalContext> = {}): ShareInvitationApprovalContext => ({
  kind: "share-invitation", version: 1, invitationId: "01HZX3Z3Z3Z3Z3Z3Z3Z3Z3Z3Z3", recipientEmail: "reader@example.com", subjectKind: "file", subjectName: "note.md",
  acceptanceExpiresAt: hour(), accessExpiresAt: hour(), ...overrides,
});
const acquire = (value: ShareInvitationApprovalContext) => acquireApprovalRequest(did, {
  profileName: "approval", jwk: key, host, invitationContext: value, expectedOwner: ownerDid,
  openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true, onApprovalRequest: () => {},
});
let localOnly: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  caseEnvironment = snapshotEnvironment();
  Object.assign(process.env, fixtureEnvironment, { TC_OPENKEY_API_HOST: server.url.origin, TC_AUTH_NO_POPUP: "1" });
  const send = globalThis.fetch;
  localOnly = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === "https://api.tinycloud.xyz" && url.pathname === "/v1/links") return send(server.url.origin + url.pathname, init);
    // The node's activation endpoint and location registry are answered locally; nothing else leaves the process.
    if (url.origin === host && url.pathname === "/delegate") { activations.push(url.pathname); return Promise.resolve(Response.json({ activated: true })); }
    if (url.origin === "https://registry.tinycloud.xyz" && /^\/v[12]\/locations\//.test(url.pathname)) {
      return Promise.resolve(new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } }));
    }
    if (url.origin !== server.url.origin) throw new Error(`Only the local fixture may receive requests: ${url.origin}`);
    return send(input, init);
  }, { preconnect: send.preconnect }));
  mode = "good"; linkPosts = 0; acknowledgements.length = 0; activations.length = 0;
  await rm(pendingFile(), { force: true });
  await ProfileManager.setProfile("approval", { name: "approval", did, sessionDid: did, ownerDid, host, chainId: 1, spaceName: "default", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey", openkeyHost: "https://openkey.example" });
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

test("an invitation request carries its context and no permissions; the key id is read from the owner-signed grant; the approval can be taken once", async () => {
  const value = context();
  const delegation = await acquire(value);
  const [entry] = (await readJson<Array<{ request: { permissions: unknown[]; context: unknown } }>>(pendingFile()))!;
  expect(entry!.request.permissions).toEqual([]);
  expect(entry!.request.context).toEqual(value);
  const grant = invitationGrantOf(delegation, key);
  expect(grant.shareId).toBe(KEY_ID);
  expect(grant.ownerDid).toBe(ownerDid);
  await takeInvitationApproval("approval", delegation);
  expect(acknowledgements).toHaveLength(1);
  expect(await readJson(pendingFile())).toEqual([]);
  await expect(takeInvitationApproval("approval", delegation)).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
});

test("a rerun for the same invitation continues the open request; a different subject kind, name, recipient or access expiry does not", async () => {
  const value = context();
  await acquire(value);
  const match = { recipientEmail: value.recipientEmail, subjectKind: value.subjectKind, subjectName: value.subjectName, accessExpiresAt: value.accessExpiresAt };
  const resumed = await pendingInvitationContext("approval", match);
  expect(resumed).toEqual(value);
  await acquire(resumed!);
  expect(linkPosts).toBe(1);
  for (const different of [{ recipientEmail: "other@example.com" }, { subjectKind: "session" as const }, { subjectName: "other.md" }, { accessExpiresAt: new Date(Date.parse(value.accessExpiresAt) + 1000).toISOString() }]) {
    expect(await pendingInvitationContext("approval", { ...match, ...different })).toBeUndefined();
  }
});

test.each<[Mode, string]>([
  ["extra-authority", "APPROVAL_RESULT_INVALID"],
  ["two-keys", "APPROVAL_RESULT_INVALID"],
  ["too-long", "APPROVAL_RESULT_INVALID"],
  ["no-binding", "APPROVAL_RESULT_INVALID"],
  ["wrong-binding", "APPROVAL_RESULT_INVALID"],
  ["other-owner", "APPROVAL_RESULT_INVALID"],
  ["other-holder", "APPROVAL_RESULT_INVALID"],
  // A correctly owner-signed result whose OWN relay binding is wrong: refused by the relay checks alone, not masked by the signed binding.
  ["inner-digest", "APPROVAL_RESULT_INVALID"],
  ["inner-id", "APPROVAL_RESULT_INVALID"],
])("a result that is %s is refused before anything is used", async (bad, code) => {
  mode = bad;
  await expect(acquire(context())).rejects.toMatchObject({ code });
  expect(acknowledgements).toEqual([]);
});

// Real owner-signed texts, so the strict parse accepts the base; each mutation calls the binding function directly on its own text.
async function signedText(bind: boolean): Promise<string> {
  const prepared = wasm.prepareSession({ abilities: {}, rawAbilities: { [`${network}/share/${KEY_ID}`]: pair }, address, chainId: 1, domain: "openkey.example", spaceId: wasm.makeSpaceId(address, 1, "default"), jwk: key,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expirationTime: new Date(Date.now() + 3_000_000).toISOString() });
  return bind ? prepared.siwe.replace(/\nResources:/, `\nRequest ID: ${line}\nResources:`) : prepared.siwe;
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
  expect(parseApprovalSiwe(unbound).requestId).toBeUndefined();
  expect(() => assertApprovalRequestBinding(unbound, mine)).toThrow();
  const bound = await signedText(true);
  for (const text of [bound.replace(/\n/g, "\r\n"), `${bound}\n`, ` ${bound}`, bound.replace("Version: 1", "Version:  1")]) {
    expect(() => parseApprovalSiwe(text)).toThrow();
  }
});

// ---- approveEmailInviteKey with the REAL identities: the owner did:pkh and the session did:key ---------------------------------

async function realSessionNode() {
  const issued = new Date();
  const spaceId = wasm.makeSpaceId(address, 1, "applications");
  const prepared = wasm.prepareSession({ abilities: { kv: { "": ["tinycloud.kv/list"] } }, address, chainId: 1, domain: "cli.example", spaceId, jwk: key,
    issuedAt: new Date(issued.getTime() - 1000).toISOString(), expirationTime: new Date(issued.getTime() + 3_600_000).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  const node = new TinyCloudNode({ host, tinycloudFallbackHosts: [host], autoDiscoverLocalNode: false, enablePublicSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false });
  await node.restoreSession({ delegationHeader: session.delegationHeader, delegationCid: session.delegationCid, spaceId, jwk: key, verificationMethod: did, address, chainId: 1,
    siwe: prepared.siwe, signature, expiresAt: new Date(issued.getTime() + 3_600_000).toISOString(), tinycloudHosts: [host] });
  return new Proxy(node, { get(target, property) {
    if (property === "activeNodeIdentity") return async () => ({ origin: host, nodeDid: "did:key:z6MkvRXNYcE7MMduynWTgeKbDaT1iijDSC8pZqXZc8rHPrf2" });
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("approveEmailInviteKey: with the real did:pkh owner and did:key session, the grant is installed as exactly one runtime key and its id is returned", async () => {
  const node = await realSessionNode();
  // The two identities differ; the check must use the owner account, never the session key.
  expect(node.credentialHolderDid).toBe(did);
  expect(node.credentialHolderDid).not.toBe(ownerDid);
  const asked: string[] = [];
  const resource = `${network}/share/${KEY_ID}`;
  const holds = () => { try { return String(sessionHoldsEncryptionDecrypt(node as unknown as TinyCloudNode, resource)); } catch (error) { return `throws ${(error as Error).message}`; } };
  expect(holds()).toBe("false");
  const access = new Date(Date.now() + 3_600_000);
  const result = await approveEmailInviteKey({
    node: node as unknown as TinyCloudNode, profile: "approval", recipientEmail: "reader@example.com", subjectName: "note.md", subjectKind: "file",
    accessExpiresAt: access, onApprovalRequest: (request) => { asked.push(request.approvalUrl); },
  });
  expect(holds()).toBe("true");
  // The signed access date is the file's own expiry, to the second.
  expect(result).toEqual({ shareId: KEY_ID, accessExpiresAt: new Date(Math.floor(access.getTime() / 1000) * 1000).toISOString() });
  const installed = node.getRuntimePermissionDelegations().flatMap((delegation) => delegation.resources ?? []).filter((resource) => resource.path.includes("/share/"));
  expect(installed.map((resource) => resource.path)).toEqual([`${network}/share/${KEY_ID}`]);
  expect([...installed[0]!.actions].sort()).toEqual([...pair].sort());
  expect(node.getVerifiedSessionCapabilities().some((entry) => entry.service === "tinycloud.encryption")).toBe(false);
  expect(acknowledgements).toHaveLength(1);
  expect(await readJson(pendingFile())).toEqual([]);
});

test("approveEmailInviteKey refuses a profile that records no owner account, and an approval signed by another account", async () => {
  const node = await realSessionNode();
  const profile = await ProfileManager.getProfile("approval");
  await ProfileManager.setProfile("approval", { ...profile, ownerDid: undefined });
  await expect(approveEmailInviteKey({ node: node as unknown as TinyCloudNode, profile: "approval", recipientEmail: "reader@example.com", subjectName: "note.md", subjectKind: "file", accessExpiresAt: new Date(Date.now() + 3_600_000) }))
    .rejects.toMatchObject({ code: "APPROVAL_REQUEST_CONTEXT_REQUIRED" });
  await ProfileManager.setProfile("approval", profile);
  mode = "other-owner";
  await expect(approveEmailInviteKey({ node: node as unknown as TinyCloudNode, profile: "approval", recipientEmail: "reader@example.com", subjectName: "note.md", subjectKind: "file", accessExpiresAt: new Date(Date.now() + 3_600_000) }))
    .rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
  expect(node.getRuntimePermissionDelegations()).toEqual([]);
});
void mock;
