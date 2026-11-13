import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { SiweMessage } from "siwe";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { admitOwnerRenewalLease } from "@tinycloud/sdk-core/delegations/renewal";
import { buildShortLink, prepareLinkRecord, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";
import { encodeDagCbor } from "../../../sdk-core/src/delegations/cacao.js";

// Synthetic owner, agent key, node and lease only: a local fixture stands in for OpenKey and the node.
const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME"] as const;
const original = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
const home = mkdtempSync("/var/tmp/TC2904-renewal-test-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier") };
Object.assign(process.env, fixtureEnvironment);
// Imported after the fixture HOME is set, so no module resolves a real profile directory.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson, writeJsonDurable } = await import("../config/storage.js");
const { acquireApprovalRequest, approvalRenewalOf } = await import("./approval-request.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");
const { relayPublicJwkOf } = await import("./device-auth.js");
function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
restoreEnvironment();

const wasm = new NodeWasmBindings();
const key = JSON.parse(wasm.createSessionManager().jwk("default")!) as Ed25519PrivateJwk;
const did = signerFromJwk(key).did;
const wallet = new PrivateKeySigner(randomBytes(32).toString("hex"));
const address = await wallet.getAddress();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "applications");
const requested = [{ service: "tinycloud.kv", space: "applications", path: "", actions: ["tinycloud.kv/list"] }];
const requestId = "abcdefghijklmnopqrstuvwxyz";
const resultRef = "synthetic-result-reference-123456";
const LEASE_SECONDS = 86_400;
const renewerPublicKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
const nodeIdentity = { nodeDid: renewerDid, renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"), renewerEpoch: 0 };

let admitted: string[] = [];
let admissionStatus = 200;
let nodeKeysStatus = 200;
let advertised: typeof nodeIdentity = nodeIdentity;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/.well-known/tinycloud/node-keys") return nodeKeysStatus === 200 ? Response.json(advertised) : new Response("unavailable", { status: nodeKeysStatus });
  if (path === "/delegate") {
    admitted.push(request.headers.get("Authorization") ?? "");
    return admissionStatus === 200 ? Response.json({ cid: "admitted", activated: [] }) : new Response("unavailable", { status: admissionStatus });
  }
  const body = await request.json() as { bodyCid: string; ackId?: string };
  const pending = await readJson<Array<{ resultEnvelope: unknown; resultExpiresAt: string }>>(join(profilePath("renewal"), "approval-pending.json"));
  if (path.endsWith("/result")) return Response.json({ resultRef, expiresAt: pending![0]!.resultExpiresAt });
  if (path.endsWith("/fetch")) return Response.json({ requestId, bodyCid: body.bodyCid, resultRef, expiresAt: pending![0]!.resultExpiresAt, relay: pending![0]!.resultEnvelope });
  return Response.json({ ackId: body.ackId, status: "acknowledged" });
} });
const host = server.url.origin;

async function signedDelegation(lifetimeSeconds = 3600) {
  const prepared = wasm.prepareSession({ abilities: { kv: { "": ["tinycloud.kv/list"] } }, address, chainId: 1,
    domain: "cli.example", spaceId, jwk: key, issuedAt: new Date(Date.now() - 1000).toISOString(),
    expirationTime: new Date(Date.now() + lifetimeSeconds * 1000).toISOString() });
  const signature = await wallet.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: { kty: key.kty, crv: key.crv, x: key.x }, verificationMethod: did,
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature } as Record<string, unknown> & { delegationCid: string };
}

/** The ReCap statement suffix sdk-core checks a CACAO's statement against (siwe-recap `to_statement`). */
function recapStatement(att: Record<string, Record<string, unknown[]>>): string {
  let index = 0;
  let lines = "";
  for (const resource of Object.keys(att).sort()) {
    const byNamespace: Record<string, string[]> = {};
    for (const ability of Object.keys(att[resource]!).sort()) (byNamespace[ability.split("/")[0]!] ??= []).push(ability.split("/")[1]!);
    for (const namespace of Object.keys(byNamespace).sort()) lines += ` (${++index}) '${namespace}': ${byNamespace[namespace]!.map((name) => `'${name}'`).join(", ")} for '${resource}'.`;
  }
  return `I further authorize the stated URI to perform the following actions on my behalf:${lines}`;
}

/**
 * An owner-signed lease that lets the node renew `target`, in the receipt shape OpenKey returns. `signer` signs it in
 * place of the owner, `att` replaces its one renew ability, and `signedEnd` is the lease's signed expiry spelling.
 */
async function renewalFor(target: string, options: { signer?: PrivateKeySigner; att?: Record<string, Record<string, unknown[]>>; signedEnd?: string } = {}) {
  const signer = options.signer ?? wallet;
  const signerAddress = await signer.getAddress();
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const approvedAt = new Date(Date.now() - 500).toISOString();
  const end = new Date(Date.now() + LEASE_SECONDS * 1000 - 60_000);
  end.setUTCMilliseconds(0);
  const expiresAt = end.toISOString();
  const signedEnd = options.signedEnd === "seconds" ? expiresAt.replace(".000Z", "Z") : expiresAt;
  const att = options.att ?? { [`urn:cid:${target}`]: { "tinycloud.delegation/renew": [{}] } };
  const statement = recapStatement(att);
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`];
  const message = new SiweMessage({ domain: "localhost", address: signerAddress, uri: renewerDid, version: "1", chainId: 1,
    nonce: "12345678", issuedAt, expirationTime: signedEnd, statement, resources }).prepareMessage();
  const signature = await signer.signMessage(message);
  const leaseAuthorization = Buffer.from(encodeDagCbor({ h: { t: "eip4361" }, p: { domain: "localhost", iss: `did:pkh:eip155:1:${signerAddress}`,
    aud: renewerDid, version: 1, nonce: "12345678", iat: issuedAt, exp: signedEnd, statement, resources },
    s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) } })).toString("base64url");
  const lease = await parseSignedSiweCacao(leaseAuthorization);
  return { version: 1 as const, approvedAt, approvedLeaseLifetimeSeconds: LEASE_SECONDS, receipt: {
    originalCid: target, leaseCid: lease.cid, leaseAuthorization, leaseExpiresAt: expiresAt, leaseGeneration: 1, nodeIdentity } };
}

/** Save a pending approval whose encrypted result OpenKey has already delivered, as a resumed login finds it. */
async function stage(delegation: Record<string, unknown>, result: Record<string, unknown>, askRenewal = true) {
  const relay = createECDH("prime256v1"); relay.generateKeys();
  const recipientJwk = relayPublicJwkOf(relay);
  const request = { issuer: did, requestVersion: 1 as const, targetDid: did,
    targetPublicJwk: { kty: key.kty, crv: key.crv, x: key.x }, nodeOrigin: host, permissions: requested, grantLifetimeSeconds: 3600,
    ...(askRenewal ? { renewal: { version: 1, leaseLifetimeSeconds: LEASE_SECONDS } } : {}), resultEncryptionPublicJwk: recipientJwk };
  const prepared = await prepareLinkRecord({ type: "openkey-approval-request", plaintext: new TextEncoder().encode(JSON.stringify(request)),
    issuerKey: signerFromJwk(key), apiOrigin: "https://api.tinycloud.xyz", expiresAt: new Date(Date.now() + 3600_000) });
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipientJwk.x, "base64url"), Buffer.from(recipientJwk.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const delegationExpiresAt = new Date((delegation.siwe as string).match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
  const plaintext = { resultVersion: 1, requestId, requestDigest: prepared.bodyCid, requesterDid: did, ownerDid, targetDid: did,
    delegationExpiresAt, delegation, ...result };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const resultEnvelope = { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral),
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  await writeJsonDurable(join(profilePath("renewal"), "approval-pending.json"), [{ version: 1, request, requestId, bodyCid: prepared.bodyCid,
    approvalUrl: buildShortLink({ origin: "https://openkey.example", type: "openkey-approval-request", id: requestId, key: prepared.key, bodyCid: prepared.bodyCid }),
    requestExpiresAt: prepared.record.header.expiresAt, record: prepared.record, apiOrigin: server.url.origin,
    linkApiOrigin: server.url.origin, openkeyOrigin: "https://openkey.example", signingKey: key,
    relayPrivateKey: relay.getPrivateKey().toString("base64url"), expectedOwner: ownerDid, resultRef,
    resultExpiresAt: new Date(Date.now() + 600_000).toISOString(), resultEnvelope, ackId: "synthetic-durable-ack-123456789" }]);
}

const acquireOptions = (askRenewal = true) => ({
  profileName: "renewal", jwk: key, host, permissions: requested, expectedOwner: ownerDid, expiry: "1h",
  openkeyHost: "https://openkey.example", openkeyApiHost: server.url.origin, noPopup: true,
  ...(askRenewal ? { renewalLeaseSeconds: LEASE_SECONDS } : {}),
  onApprovalRequest: () => { throw new Error("The approval was already given"); },
});
const acquire = (askRenewal = true) => acquireApprovalRequest(did, acquireOptions(askRenewal));
const pendingCount = async () => (await readJson<unknown[]>(join(profilePath("renewal"), "approval-pending.json")))?.length ?? 0;

beforeEach(async () => {
  // Links API is the local fixture: a case that failed to resume could never post a real approval link.
  Object.assign(process.env, fixtureEnvironment, { TC_LINKS_API_ORIGIN: server.url.origin });
  admitted = []; admissionStatus = 200; nodeKeysStatus = 200; advertised = nodeIdentity;
  await ProfileManager.setProfile("renewal", { name: "renewal", did, sessionDid: did, ownerDid, host, tinycloudRegistryUrl: server.url.origin, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey("renewal", key);
});
afterEach(async () => {
  await rm(join(profilePath("renewal"), "approval-pending.json"), { force: true });
  delete process.env.TC_LINKS_API_ORIGIN;
  restoreEnvironment();
});
afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

test("a leased approval is verified and admitted at the node before the login can save it", async () => {
  const delegation = await signedDelegation();
  const renewal = await renewalFor(delegation.delegationCid);
  await stage(delegation, { renewalChoice: "leased", renewal });
  const acquired = await acquire();
  expect(acquired.delegationCid).toBe(delegation.delegationCid);
  expect(approvalRenewalOf(acquired)).toEqual(renewal);
  expect(admitted).toEqual([renewal.receipt.leaseAuthorization]);
});

test("a finite choice on a renewable request saves no lease", async () => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "finite" });
  const acquired = await acquire();
  expect(approvalRenewalOf(acquired)).toBeUndefined();
  expect(admitted).toEqual([]);
});

test("a lease in the result of a request that asked for none is never kept", async () => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "leased", renewal: await renewalFor(delegation.delegationCid) }, false);
  const acquired = await acquire(false);
  expect(approvalRenewalOf(acquired)).toBeUndefined();
  expect(admitted).toEqual([]);
});

test("a lease for a different grant refuses the approval for good and is never admitted", async () => {
  const delegation = await signedDelegation();
  const other = await signedDelegation();
  const renewal = await renewalFor(other.delegationCid);
  await stage(delegation, { renewalChoice: "leased", renewal: { ...renewal, receipt: { ...renewal.receipt, originalCid: delegation.delegationCid } } });
  await expect(acquire()).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
  expect(admitted).toEqual([]);
  expect(await pendingCount()).toBe(0);
});

test("a grant with under 15 minutes left is refused before its lease is admitted", async () => {
  const delegation = await signedDelegation(14 * 60);
  await stage(delegation, { renewalChoice: "leased", renewal: await renewalFor(delegation.delegationCid) });
  await expect(acquire()).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
  expect(admitted).toEqual([]);
  expect(await pendingCount()).toBe(0);
});

test("a node that does not accept the lease keeps the approval for the same command to retry", async () => {
  const delegation = await signedDelegation();
  const renewal = await renewalFor(delegation.delegationCid);
  await stage(delegation, { renewalChoice: "leased", renewal });
  admissionStatus = 503;
  await expect(acquire()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  expect(await pendingCount()).toBe(1);
  admissionStatus = 200;
  const acquired = await acquire();
  expect(approvalRenewalOf(acquired)).toEqual(renewal);
  expect(admitted).toEqual([renewal.receipt.leaseAuthorization, renewal.receipt.leaseAuthorization]);
});

test("a node that no longer advertises the lease's renewer refuses the approval for good", async () => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "leased", renewal: await renewalFor(delegation.delegationCid) });
  advertised = { ...nodeIdentity, renewerEpoch: 1 };
  await expect(acquire()).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
  expect(admitted).toEqual([]);
  expect(await pendingCount()).toBe(0);
});

// The CLI tells a changed node identity (permanent) from other admission failures (retry) by this exact SDK message.
// A reworded SDK error must fail here, not quietly turn the refusal back into a retry.
test("the SDK reports a changed renewer with the exact message the CLI matches", async () => {
  const delegation = await signedDelegation();
  const { receipt } = await renewalFor(delegation.delegationCid);
  advertised = { ...nodeIdentity, renewerEpoch: 1 };
  await expect(admitOwnerRenewalLease({ host, originalAuthorization: (delegation.delegationHeader as { Authorization: string }).Authorization,
    originalCid: delegation.delegationCid, ownerDid, agentDid: did, spaceId, nodeIdentity, leaseAuthorization: receipt.leaseAuthorization,
    leaseCid: receipt.leaseCid, leaseExpiresAt: receipt.leaseExpiresAt })).rejects.toThrow(/^Renewal node identity changed$/);
  expect(admitted).toEqual([]);
});

test("a lease signed by anyone but the grant's owner is refused and never admitted", async () => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "leased", renewal: await renewalFor(delegation.delegationCid, { signer: new PrivateKeySigner(randomBytes(32).toString("hex")) }) });
  await expect(acquire()).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
  expect(admitted).toEqual([]);
});

test.each([
  ["a second ability", (target: string) => ({ [`urn:cid:${target}`]: { "tinycloud.delegation/renew": [{}], "tinycloud.delegation/list": [{}] } })],
  ["a second resource", (target: string) => ({ [`urn:cid:${target}`]: { "tinycloud.delegation/renew": [{}] }, "urn:cid:bafyreiother": { "tinycloud.delegation/renew": [{}] } })],
])("a lease that grants %s besides renewing this grant is refused and never admitted", async (_label, att) => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "leased", renewal: await renewalFor(delegation.delegationCid, { att: att(delegation.delegationCid) }) });
  await expect(acquire()).rejects.toMatchObject({ code: "APPROVAL_RESULT_INVALID" });
  expect(admitted).toEqual([]);
});

test("a lease signed with a whole-second expiry is admitted with exactly the signed value", async () => {
  const delegation = await signedDelegation();
  const renewal = await renewalFor(delegation.delegationCid, { signedEnd: "seconds" });
  await stage(delegation, { renewalChoice: "leased", renewal });
  expect(approvalRenewalOf(await acquire())).toEqual(renewal);
  expect(admitted).toEqual([renewal.receipt.leaseAuthorization]);
});

test("a node that cannot report its identity right now keeps the approval for a retry", async () => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "leased", renewal: await renewalFor(delegation.delegationCid) });
  nodeKeysStatus = 503;
  await expect(acquire()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  expect(admitted).toEqual([]);
  expect(await pendingCount()).toBe(1);
});

const session = async () => JSON.parse(await Bun.file(join(profilePath("renewal"), "session.json")).text()) as Record<string, unknown>;

test("a sign-in saves the verified lease with its session", async () => {
  const delegation = await signedDelegation();
  const renewal = await renewalFor(delegation.delegationCid);
  await stage(delegation, { renewalChoice: "leased", renewal });
  await refreshOpenKeySession("renewal", host, {
    openKeyAcquisition: (async (d: string, flow: Record<string, unknown>) => acquireApprovalRequest(d, { ...flow, ...acquireOptions() } as never)) as never,
  });
  expect((await session()).renewal).toEqual(renewal);
});

test("a lease attached to the sign-in result outside the verified approval is never saved", async () => {
  const delegation = await signedDelegation();
  const injected = await renewalFor(delegation.delegationCid);
  await stage(delegation, {}, false);
  await refreshOpenKeySession("renewal", host, {
    openKeyAcquisition: (async (d: string, flow: Record<string, unknown>) =>
      Object.assign(await acquireApprovalRequest(d, { ...flow, ...acquireOptions(false) } as never), { renewal: injected })) as never,
  });
  expect(await session()).not.toHaveProperty("renewal");
  expect(admitted).toEqual([]);
});
