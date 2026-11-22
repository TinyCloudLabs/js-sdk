import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createCipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ed25519 } from "@noble/curves/ed25519";
import { bases } from "multiformats/basics";
import { SiweMessage } from "siwe";
import { Command } from "commander";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { parseSignedSiweCacao } from "@tinycloud/sdk-core";
import { buildShortLink, MAX_APPROVAL_LEASE_SECONDS, prepareLinkRecord, signerFromJwk, type Ed25519PrivateJwk } from "@tinycloud/share-envelope/links";
import { encodeDagCbor } from "../../../sdk-core/src/delegations/cacao.js";

// TC-3522: OpenKey sign-in through an approval link asks the owner for a renewal lease by default. Synthetic owner, agent
// key, node and lease only: a local fixture stands in for OpenKey, the links API and the node.
const environmentKeys = ["HOME", "TC_HOME", "COURIER_HOME"] as const;
const original = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
const home = mkdtempSync("/var/tmp/TC3522-lease-ask-test-");
chmodSync(home, 0o700);
const fixtureEnvironment = { HOME: home, TC_HOME: join(home, "tc"), COURIER_HOME: join(home, "courier") };
Object.assign(process.env, fixtureEnvironment);
// Imported after the fixture HOME is set, so no module resolves a real profile directory.
const { ProfileManager } = await import("../config/profiles.js");
const { profilePath } = await import("@tinycloud/operations/state");
const { readJson, writeJsonDurable } = await import("../config/storage.js");
const { acquireApprovalRequest } = await import("./approval-request.js");
const { refreshOpenKeySession } = await import("../commands/auth.js");
const { registerStatusCommand } = await import("../commands/status.js");
const { relayPublicJwkOf } = await import("./device-auth.js");
const { DEFAULT_RENEWAL_LEASE_SECONDS, parseRenewOption, renewalLeaseFor } = await import("./renewal-lease.js");
function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}
restoreEnvironment();

type LoginOptions = NonNullable<Parameters<typeof refreshOpenKeySession>[2]>;
const DAY = 86_400;
const PROFILE = "lease";
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
const renewerPublicKey = ed25519.getPublicKey(ed25519.utils.randomPrivateKey());
const renewerDid = `did:key:${bases.base58btc.encode(new Uint8Array([0xed, 0x01, ...renewerPublicKey]))}`;
const nodeIdentity = { nodeDid: renewerDid, renewerDid, renewerPublicKey: Buffer.from(renewerPublicKey).toString("base64url"), renewerEpoch: 0 };

let paths: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  paths.push(path);
  if (path === "/.well-known/tinycloud/node-keys") return Response.json(nodeIdentity);
  if (path === "/delegate") return Response.json({ cid: "admitted", activated: [] });
  if (path === "/v1/links") return new Response("no new approval request is expected", { status: 500 });
  const body = await request.json() as { bodyCid: string; ackId?: string };
  const pending = await readJson<Array<{ resultEnvelope: unknown; resultExpiresAt: string }>>(join(profilePath(PROFILE), "approval-pending.json"));
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
    address, chainId: 1, spaceId, ownerDid, siwe: prepared.siwe, signature } as Record<string, unknown> & { delegationCid: string; siwe: string };
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

/** An owner-signed lease of `leaseSeconds` that lets the node renew `target`, in the receipt shape OpenKey returns. */
async function renewalFor(target: string, leaseSeconds: number) {
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const approvedAt = new Date(Date.now() - 500).toISOString();
  const end = new Date(Date.now() + leaseSeconds * 1000 - 60_000);
  end.setUTCMilliseconds(0);
  const expiresAt = end.toISOString();
  const att = { [`urn:cid:${target}`]: { "tinycloud.delegation/renew": [{}] } };
  const statement = recapStatement(att);
  const resources = [`urn:recap:${Buffer.from(JSON.stringify({ att, prf: [] })).toString("base64url")}`];
  const message = new SiweMessage({ domain: "localhost", address, uri: renewerDid, version: "1", chainId: 1,
    nonce: "12345678", issuedAt, expirationTime: expiresAt, statement, resources }).prepareMessage();
  const signature = await wallet.signMessage(message);
  const leaseAuthorization = Buffer.from(encodeDagCbor({ h: { t: "eip4361" }, p: { domain: "localhost", iss: ownerDid,
    aud: renewerDid, version: 1, nonce: "12345678", iat: issuedAt, exp: expiresAt, statement, resources },
    s: { t: "eip191", s: new Uint8Array(Buffer.from(signature.slice(2), "hex")) } })).toString("base64url");
  const lease = await parseSignedSiweCacao(leaseAuthorization);
  return { version: 1 as const, approvedAt, approvedLeaseLifetimeSeconds: leaseSeconds, receipt: {
    originalCid: target, leaseCid: lease.cid, leaseAuthorization, leaseExpiresAt: expiresAt, leaseGeneration: 1, nodeIdentity } };
}

/** Save a pending approval asking for `leaseSeconds` (no lease when undefined) whose encrypted result OpenKey has already delivered. */
async function stage(delegation: { siwe: string }, result: Record<string, unknown>, leaseSeconds: number | undefined) {
  const relay = createECDH("prime256v1"); relay.generateKeys();
  const recipientJwk = relayPublicJwkOf(relay);
  const request = { issuer: did, requestVersion: 1 as const, targetDid: did,
    targetPublicJwk: { kty: key.kty, crv: key.crv, x: key.x }, nodeOrigin: host, permissions: requested, grantLifetimeSeconds: 3600,
    ...(leaseSeconds === undefined ? {} : { renewal: { version: 1, leaseLifetimeSeconds: leaseSeconds } }), resultEncryptionPublicJwk: recipientJwk };
  const prepared = await prepareLinkRecord({ type: "openkey-approval-request", plaintext: new TextEncoder().encode(JSON.stringify(request)),
    issuerKey: signerFromJwk(key), apiOrigin: "https://links.example", expiresAt: new Date(Date.now() + 3600_000) });
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.concat([Buffer.from([4]), Buffer.from(recipientJwk.x, "base64url"), Buffer.from(recipientJwk.y, "base64url")]));
  const extracted = createHmac("sha256", Buffer.from(requestId)).update(shared).digest();
  const encryptionKey = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(Buffer.from(requestId));
  const delegationExpiresAt = new Date(delegation.siwe.match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
  const plaintext = { resultVersion: 1, requestId, requestDigest: prepared.bodyCid, requesterDid: did, ownerDid, targetDid: did,
    delegationExpiresAt, delegation, ...result };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const resultEnvelope = { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: relayPublicJwkOf(ephemeral),
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  await writeJsonDurable(join(profilePath(PROFILE), "approval-pending.json"), [{ version: 1, request, requestId, bodyCid: prepared.bodyCid,
    approvalUrl: buildShortLink({ origin: "https://openkey.example", type: "openkey-approval-request", id: requestId, key: prepared.key, bodyCid: prepared.bodyCid }),
    requestExpiresAt: prepared.record.header.expiresAt, record: prepared.record, apiOrigin: host,
    linkApiOrigin: host, openkeyOrigin: "https://openkey.example", signingKey: key,
    relayPrivateKey: relay.getPrivateKey().toString("base64url"), expectedOwner: ownerDid, resultRef,
    resultExpiresAt: new Date(Date.now() + 600_000).toISOString(), resultEnvelope, ackId: "synthetic-durable-ack-123456789" }]);
}

/** The approval-link flow with this fixture's permissions and hosts; the lease ask is the one sign-in chose. */
let acquisitions = 0;
const viaFixture = (async (requester: string, flow: Record<string, unknown>) => {
  acquisitions++;
  return acquireApprovalRequest(requester, { ...flow, profileName: PROFILE, jwk: key, host, permissions: requested,
    expectedOwner: ownerDid, expiry: "1h", openkeyHost: "https://openkey.example", openkeyApiHost: host, noPopup: true,
    onApprovalRequest: () => { throw new Error("The approval was already given"); } } as never);
}) as never;

class Asked extends Error {
  constructor(readonly lease: number | undefined) { super("asked"); }
}
/** The renewal lease sign-in would put in its approval request (or none), without asking anyone. */
async function leaseAsked(options: LoginOptions): Promise<number | undefined> {
  const capture = (async (_requester: string, flow: { renewalLeaseSeconds?: number }) => {
    throw new Asked(flow.renewalLeaseSeconds);
  }) as never;
  const error = await refreshOpenKeySession(PROFILE, host, { ...options, openKeyAcquisition: capture }).then(() => undefined, (failure: unknown) => failure);
  if (!(error instanceof Asked)) throw error;
  return error.lease;
}

const sessionFile = () => join(profilePath(PROFILE), "session.json");
const session = async () => JSON.parse(await Bun.file(sessionFile()).text()) as Record<string, unknown>;

async function captured(stream: NodeJS.WriteStream, run: () => Promise<unknown>): Promise<string> {
  let text = "";
  const write = stream.write;
  stream.write = ((chunk: unknown) => { text += String(chunk); return true; }) as typeof stream.write;
  try { await run(); } finally { stream.write = write; }
  return text;
}

async function status(): Promise<string> {
  const program = new Command().option("--profile <name>");
  registerStatusCommand(program);
  return captured(process.stdout, () => program.parseAsync(["node", "tc", "status"], { from: "node" }));
}

beforeEach(async () => {
  Object.assign(process.env, fixtureEnvironment, { TC_LINKS_API_ORIGIN: host });
  paths = []; acquisitions = 0;
  await ProfileManager.setProfile(PROFILE, { name: PROFILE, did, sessionDid: did, ownerDid, host, tinycloudRegistryUrl: host, chainId: 1, spaceName: "applications", createdAt: new Date().toISOString(), authMethod: "openkey", posture: "owner-openkey" });
  await ProfileManager.setKey(PROFILE, key);
});
afterEach(async () => {
  await rm(join(profilePath(PROFILE), "approval-pending.json"), { force: true });
  await rm(sessionFile(), { force: true });
  delete process.env.TC_LINKS_API_ORIGIN;
  restoreEnvironment();
});
afterAll(async () => {
  server.stop(true);
  await rm(home, { recursive: true, force: true });
});

test("--renew accepts a duration up to the approval lease maximum and refuses anything else", () => {
  expect(parseRenewOption(`${MAX_APPROVAL_LEASE_SECONDS / DAY}d`)).toBe(MAX_APPROVAL_LEASE_SECONDS);
  expect(() => parseRenewOption(`${MAX_APPROVAL_LEASE_SECONDS / DAY + 1}d`)).toThrow(expect.objectContaining({ code: "INVALID_RENEW" }));
  expect(() => parseRenewOption("soon")).toThrow(expect.objectContaining({ code: "INVALID_RENEW" }));
});

test("the default lease is asked only beside a shorter grant; a named lease must outlast the grant", () => {
  expect(renewalLeaseFor(undefined, DEFAULT_RENEWAL_LEASE_SECONDS - 1)).toBe(DEFAULT_RENEWAL_LEASE_SECONDS);
  expect(renewalLeaseFor(undefined, DEFAULT_RENEWAL_LEASE_SECONDS)).toBeUndefined();
  expect(renewalLeaseFor(false, DAY)).toBeUndefined();
  expect(renewalLeaseFor(2 * DAY, DAY)).toBe(2 * DAY);
  expect(() => renewalLeaseFor(DAY, DAY)).toThrow(expect.objectContaining({ code: "INVALID_RENEW" }));
  expect(() => renewalLeaseFor(DAY - 1, DAY)).toThrow(expect.objectContaining({ code: "INVALID_RENEW" }));
});

test("sign-in through an approval link asks for the default lease unless told otherwise", async () => {
  expect(await leaseAsked({})).toBe(DEFAULT_RENEWAL_LEASE_SECONDS);
  expect(await leaseAsked({ renew: 90 * DAY })).toBe(90 * DAY);
  expect(await leaseAsked({ renew: false })).toBeUndefined();
  // A grant already as long as the default lease gains nothing from it.
  expect(await leaseAsked({ expiry: `${DEFAULT_RENEWAL_LEASE_SECONDS / DAY}d` })).toBeUndefined();
});

test("a sign-in asking for decrypt or the secrets space asks for no renewal by default, and a named --renew asks for its length", async () => {
  const decrypt = { service: "tinycloud.encryption", space: "encryption", path: `urn:tinycloud:encryption:${ownerDid}:default`, actions: ["tinycloud.encryption/decrypt"] };
  const secret = { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/KEY", actions: ["tinycloud.kv/get"] };
  expect(await leaseAsked({ permissions: requested, expiry: "1h" })).toBe(DEFAULT_RENEWAL_LEASE_SECONDS);
  for (const permissions of [[...requested, decrypt], [secret], [secret, decrypt]]) {
    expect(await leaseAsked({ permissions, expiry: "1h" })).toBeUndefined();
    expect(await leaseAsked({ permissions, expiry: "1h", renew: 7 * DAY })).toBe(7 * DAY);
  }
});

test("a paste link never asks for a lease, and a named --renew with one is refused before OpenKey is asked", async () => {
  expect(await leaseAsked({ paste: true })).toBeUndefined();
  await expect(leaseAsked({ paste: true, renew: 90 * DAY })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(leaseAsked({ expiry: "7d", renew: 7 * DAY })).rejects.toMatchObject({ code: "INVALID_RENEW" });
});

test("a leased sign-in saves its lease in a 0600 session, and status shows both the grant's end and the lease's", async () => {
  const delegation = await signedDelegation();
  const renewal = await renewalFor(delegation.delegationCid, DEFAULT_RENEWAL_LEASE_SECONDS);
  await stage(delegation, { renewalChoice: "leased", renewal }, DEFAULT_RENEWAL_LEASE_SECONDS);
  await refreshOpenKeySession(PROFILE, host, { openKeyAcquisition: viaFixture });
  expect((await session()).renewal).toEqual(renewal);
  expect(statSync(sessionFile()).mode & 0o777).toBe(0o600);
  expect(statSync(join(profilePath(PROFILE), "key.json")).mode & 0o777).toBe(0o600);
  expect(paths).not.toContain("/v1/links");

  const grantEnd = new Date(delegation.siwe.match(/^Expiration Time:\s*(.+)$/m)![1]!).toISOString();
  const summary = JSON.parse(await status()) as { profiles: Array<{ name: string; session: { expiresAt: string | null; renewsUntil: string | null } }> };
  const shown = summary.profiles.find((profile) => profile.name === PROFILE)!.session;
  expect(shown).toMatchObject({ expiresAt: grantEnd, renewsUntil: renewal.receipt.leaseExpiresAt });

  const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    expect(await status()).toContain(`, renews until ${renewal.receipt.leaseExpiresAt}`);
  } finally {
    if (tty) Object.defineProperty(process.stdout, "isTTY", tty); else Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

test("an owner who approves without renewal gets a sign-in that ends at its expiry, one note, and no second request", async () => {
  const delegation = await signedDelegation();
  await stage(delegation, { renewalChoice: "finite" }, DEFAULT_RENEWAL_LEASE_SECONDS);
  const stderr = await captured(process.stderr, () => refreshOpenKeySession(PROFILE, host, { openKeyAcquisition: viaFixture }));
  const saved = await session();
  expect(saved).not.toHaveProperty("renewal");
  expect(saved.delegationCid).toBe(delegation.delegationCid);
  expect(stderr).toContain("approved this sign-in without renewal");
  expect(acquisitions).toBe(1);
  expect(paths).not.toContain("/v1/links");
  expect(paths).not.toContain("/delegate");
  expect(await readJson(join(profilePath(PROFILE), "approval-pending.json"))).toEqual([]);
});

test("a saved request is taken only by a sign-in with the same lease ask, both ways", async () => {
  const delegation = await signedDelegation();
  const renewal = await renewalFor(delegation.delegationCid, DEFAULT_RENEWAL_LEASE_SECONDS);
  await stage(delegation, { renewalChoice: "leased", renewal }, DEFAULT_RENEWAL_LEASE_SECONDS);
  // --no-renew never takes an approval that carries a lease: it goes on to make a new request, which this fixture's
  // loopback links API origin stops (LinkError) before anything is sent.
  await expect(refreshOpenKeySession(PROFILE, host, { renew: false, openKeyAcquisition: viaFixture })).rejects.toMatchObject({ name: "LinkError" });
  expect(await Bun.file(sessionFile()).exists()).toBe(false);

  await rm(join(profilePath(PROFILE), "approval-pending.json"), { force: true });
  await stage(delegation, {}, undefined);
  // A request without a lease never answers a sign-in that asks for one.
  await expect(refreshOpenKeySession(PROFILE, host, { openKeyAcquisition: viaFixture })).rejects.toMatchObject({ name: "LinkError" });
  expect(await Bun.file(sessionFile()).exists()).toBe(false);

  await rm(join(profilePath(PROFILE), "approval-pending.json"), { force: true });
  await stage(delegation, {}, undefined);
  paths = [];
  await refreshOpenKeySession(PROFILE, host, { renew: false, openKeyAcquisition: viaFixture });
  expect((await session()).delegationCid).toBe(delegation.delegationCid);
  expect(await session()).not.toHaveProperty("renewal");
  expect(paths).not.toContain("/v1/links");
});

const execFileAsync = promisify(execFile);
test.each([
  ["--device", ["--device", "--renew", "30d"]],
  ["--paste", ["--paste", "--renew", "30d"]],
  ["--method local", ["--method", "local", "--renew", "30d"]],
  ["a lease over the maximum", ["--renew", `${MAX_APPROVAL_LEASE_SECONDS / DAY + 1}d`]],
])("auth login refuses --renew with %s before any sign-in starts", async (_label, flags) => {
  const script = `
    import { Command } from "commander";
    import { registerAuthCommand } from ${JSON.stringify(join(import.meta.dir, "../commands/auth.ts"))};
    const program = new Command().option("--profile <name>");
    registerAuthCommand(program);
    await program.parseAsync(${JSON.stringify(["node", "tc", "--profile", "renew-refused", "auth", "login", ...flags, "--no-popup"])}, { from: "node" });
  `;
  const run = await execFileAsync("bun", ["-e", script], { cwd: resolve(import.meta.dir, "../../../.."), env: { ...process.env, ...fixtureEnvironment, TC_LINKS_API_ORIGIN: host } })
    .then(({ stderr }) => ({ code: 0, stderr }), (error: Error & { code?: number; stderr?: string }) => ({ code: error.code, stderr: error.stderr ?? "" }));
  expect(run.code).toBe(2);
  expect(run.stderr).toContain("--renew");
  expect(paths).toEqual([]);
});
