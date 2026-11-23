import { expect, test } from "bun:test";
import { createCipheriv, createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeWasmBindings, PrivateKeySigner } from "@tinycloud/node-sdk";
import { withTinyCloudStateRoot } from "@tinycloud/operations/state";
import { parseSignedSiweCacao, publicJwk } from "@tinycloud/sdk-core";
import type { ApprovalRenewal } from "@tinycloud/share-envelope/links";
import { SiweMessage } from "siwe";
import { encodeDagCbor } from "../../../sdk-core/src/delegations/cacao.js";
import { ProfileManager } from "../config/profiles.js";
import { loginWithDeviceAuthorization } from "./device-auth.js";
import { generateKey, keyToDID } from "./local-key.js";

const signer = new PrivateKeySigner("4f3edf983ac636a65a842ce7c78d9aa706d3b113bce036f4d9c5c1b5605dce6f");
const address = await signer.getAddress();
const wasm = new NodeWasmBindings();
const ownerDid = `did:pkh:eip155:1:${address}`;
const spaceId = wasm.makeSpaceId(address, 1, "default");
const renewer = generateKey().jwk as { x: string };
const nodeIdentity = { nodeDid: generateKey().did.split("#")[0]!, renewerDid: keyToDID(renewer).split("#")[0]!, renewerPublicKey: renewer.x, renewerEpoch: 2 };
const permissions = [
  { service: "tinycloud.capabilities", space: "default", path: "", actions: ["tinycloud.capabilities/read"] },
  { service: "tinycloud.kv", space: "default", path: "notes/", actions: ["tinycloud.kv/get"] },
];
const transactionId = "device-renewal-transaction";
const leaseSeconds = 30 * 86_400;
const profileName = "device-renewal";

async function relay(recipient: JsonWebKey, value: unknown) {
  const curve = { name: "ECDH", namedCurve: "P-256" };
  const ephemeral = await crypto.subtle.generateKey(curve, true, ["deriveBits"]);
  const peer = await crypto.subtle.importKey("jwk", recipient, curve, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, ephemeral.privateKey, 256);
  const extracted = createHmac("sha256", transactionId).update(Buffer.from(shared)).digest();
  const key = createHmac("sha256", extracted).update("openkey-device-relay-v1").update(Buffer.from([1])).digest();
  const nonce = Buffer.alloc(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(transactionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { version: 1, algorithm: "ECDH-P256-A256GCM", ephemeralPublicJwk: await crypto.subtle.exportKey("jwk", ephemeral.publicKey),
    nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}

async function signedGrant(jwk: object) {
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000).toISOString();
  const prepared = wasm.prepareSession({ jwk, address, chainId: 1, domain: "openkey.example", spaceId,
    abilities: { capabilities: { "": ["tinycloud.capabilities/read"] }, kv: { "notes/": ["tinycloud.kv/get"] } },
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expirationTime: expiresAt });
  const signature = await signer.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  return { ...session, jwk: publicJwk(jwk), verificationMethod: keyToDID(jwk), address, chainId: 1, spaceId, ownerDid,
    permissions, siwe: prepared.siwe, signature, expiresAt, spaceReady: true };
}

async function signedRenewal(target: string, lifetime: number): Promise<ApprovalRenewal> {
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + lifetime * 1000).toISOString();
  const resource = `urn:cid:${target}`;
  const recap = { att: { [resource]: { "tinycloud.delegation/renew": [{}] } }, prf: [] };
  const resources = [`urn:recap:${Buffer.from(JSON.stringify(recap)).toString("base64url")}`];
  const statement = `I further authorize the stated URI to perform the following actions on my behalf: (1) 'tinycloud.delegation': 'renew' for '${resource}'.`;
  const nonce = "12345678";
  const domain = "127.0.0.1";
  const signature = await signer.signMessage(new SiweMessage({ domain, address, uri: nodeIdentity.renewerDid, version: "1",
    chainId: 1, nonce, issuedAt, expirationTime: expiresAt, statement, resources }).prepareMessage());
  const leaseAuthorization = Buffer.from(encodeDagCbor({ h: { t: "eip4361" }, p: { domain, iss: ownerDid, aud: nodeIdentity.renewerDid,
    version: 1, nonce, iat: issuedAt, exp: expiresAt, statement, resources }, s: { t: "eip191", s: Buffer.from(signature.slice(2), "hex") } })).toString("base64url");
  return { version: 1, approvedAt: issuedAt, approvedLeaseLifetimeSeconds: lifetime, receipt: {
    originalCid: target, leaseAuthorization, leaseCid: (await parseSignedSiweCacao(leaseAuthorization)).cid,
    leaseExpiresAt: expiresAt, leaseGeneration: 1, nodeIdentity,
  } };
}

type Fixture = {
  ask?: false;
  result?: "legacy" | "declined" | "wallet" | "grafted" | "over-ask" | "no-extension" | "shifted-issued-at" | "invalid-base";
  clock?: "missing" | "late" | "late-in-transit" | "future-issuance";
  node?: "refuse-original" | "wrong-original-cid" | "refuse-lease" | "wrong-identity";
  loseCommit?: boolean;
  cliFlags?: string[];
};

async function run(fixture: Fixture = {}) {
  const home = await mkdtemp(join(tmpdir(), "tc-device-renewal-"));
  const key = generateKey().jwk;
  const grant = await signedGrant(key);
  const target = fixture.result === "grafted" ? (await signedGrant(generateKey().jwk)).delegationCid : grant.delegationCid;
  const renewal = await signedRenewal(target, fixture.result === "over-ask" ? leaseSeconds + 1 : fixture.result === "no-extension" ? 3600 : leaseSeconds);
  let start: Record<string, unknown> | undefined;
  const events: string[] = [];
  let pollProof: unknown;
  let ackProof: unknown;
  let atAck: object | null | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => withTinyCloudStateRoot(home, async () => {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/device-authorizations":
        events.push("start");
        start = await request.json() as Record<string, unknown>;
        return Response.json({ transactionId, userCode: "ABCD-EFGH", verificationUri: `${url.origin}/device`, expiresIn: 600, interval: 1 });
      case "/api/device-authorizations/token": {
        events.push("poll");
        pollProof = await request.json();
        const result = fixture.result === "legacy" ? {} : fixture.result === "declined" || fixture.result === "wallet"
          ? { renewal: null, renewalReason: fixture.result === "wallet" ? "renewal_wallet_unsupported" : "renewal_declined" }
          : { renewal: fixture.result === "shifted-issued-at" ? { ...renewal, approvedAt: new Date(Date.parse(renewal.approvedAt) + 1).toISOString() } : renewal };
        // This case crosses the admission deadline in actual HTTP transit.
        if (fixture.clock === "late-in-transit") await Bun.sleep(150);
        const offset = fixture.clock === "late" ? 480_000 : fixture.clock === "late-in-transit" ? 479_900 : fixture.clock === "future-issuance" ? -31_000 : 1000;
        return Response.json({ status: "approved", ...(fixture.clock === "missing" ? {} : { serverTime: new Date(Date.parse(renewal.approvedAt) + offset).toISOString() }),
          relay: await relay(start!.relayPublicJwk as JsonWebKey, { ...grant, ...result }), binding: {
            transactionId, sessionDid: start!.sessionDid, nodeOrigin: url.origin, shareOrigin: start!.shareOrigin,
            permissions: fixture.result === "invalid-base" ? permissions.slice(0, 1) : permissions, delegationExpiresAt: grant.expiresAt,
          } });
      }
      case "/.well-known/tinycloud/node-keys":
        events.push("identity");
        return Response.json(fixture.node === "wrong-identity" ? { ...nodeIdentity, renewerEpoch: 3 } : nodeIdentity);
      case "/delegate": {
        const authorization = request.headers.get("authorization");
        if (authorization === grant.delegationHeader.Authorization) {
          events.push("original");
          if (fixture.node === "refuse-original") return new Response(null, { status: 409 });
          return Response.json({ cid: fixture.node === "wrong-original-cid" ? renewal.receipt.leaseCid : grant.delegationCid, activated: [] });
        }
        if (authorization !== renewal.receipt.leaseAuthorization) return new Response("Unexpected proof", { status: 400 });
        events.push("lease");
        if (fixture.loseCommit) await ProfileManager.setProfile(profileName, { name: profileName, did: keyToDID(key), host: url.origin,
          spaceName: "default", chainId: 1, createdAt: "2026-01-01T00:00:00.000Z" });
        if (fixture.node === "refuse-lease") return new Response(null, { status: 409 });
        return Response.json({ cid: renewal.receipt.leaseCid, activated: [] });
      }
      case `/api/device-authorizations/${transactionId}/ack`:
        events.push("ack");
        ackProof = await request.json();
        atAck = await ProfileManager.getSession(profileName);
        return Response.json({ status: "acknowledged" });
      default: return new Response(null, { status: 404 });
    }
  }) });
  try {
    return await withTinyCloudStateRoot(home, async () => {
      const origin = server.url.origin;
      await ProfileManager.setProfile(profileName, { name: profileName, did: keyToDID(key), host: origin, ownerDid,
        spaceName: "default", chainId: 1, createdAt: "2026-01-02T00:00:00.000Z" });
      await ProfileManager.setKey(profileName, key);
      const previous = fixture.loseCommit ? { ...grant, jwk: key, renewal: await signedRenewal(grant.delegationCid, 7 * 86_400) } : undefined;
      if (previous) await ProfileManager.setSession(profileName, previous);
      const cli = fixture.cliFlags === undefined ? undefined : await runCli(home, origin, fixture.cliFlags);
      const input = { profileName, permissions, nodeOrigin: origin, shareOrigin: origin, openkeyHost: origin,
        ...(fixture.ask === false ? {} : { renewalLeaseSeconds: leaseSeconds }), replaceSession: fixture.loseCommit,
        wait: async () => {}, emitInstructions: () => {} };
      const login = cli ? {} : await loginWithDeviceAuthorization(input).then((value) => ({ value, error: undefined }), (error: unknown) => ({ error, value: undefined }));
      return { ...login, cli, grant, renewal, start, events, pollProof, ackProof, atAck, previous, saved: await ProfileManager.getSession(profileName) };
    });
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}

async function runCli(home: string, origin: string, flags: string[]) {
  const manifest = `base64:${Buffer.from(JSON.stringify({ app_id: "test.device-renewal", name: "Device renewal test", space: "default",
    permissions: permissions.map(({ service, path, actions }) => ({ service, path, actions, skipPrefix: true })) })).toString("base64")}`;
  const script = `
    import { Command } from "commander";
    import { registerAuthCommand } from ${JSON.stringify(new URL("../commands/auth.ts", import.meta.url).pathname)};
    const program = new Command().option("--profile <name>").option("--host <url>");
    registerAuthCommand(program);
    await program.parseAsync(${JSON.stringify(["--profile", profileName, "--host", origin, "auth", "login", "--device", "--manifest", manifest, ...flags])}, { from: "user" });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: import.meta.dir,
    env: { ...process.env, HOME: home, TC_HOME: home, TC_OPENKEY_HOST: origin, TC_OPENKEY_API_HOST: origin, TC_LINKS_API_ORIGIN: origin },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
  return { code, stdout, stderr };
}

test("device login replays the exact grant, admits the lease, and durably saves it before ACK", async () => {
  const result = await run();
  expect(result.error).toBeUndefined();
  expect(result.start).toMatchObject({ renewal: { version: 1, leaseLifetimeSeconds: leaseSeconds }, delegationTtlSeconds: leaseSeconds, suggestedTtlSeconds: 604_800 });
  expect(result.events).toEqual(["start", "poll", "original", "identity", "lease", "ack"]);
  expect(result.atAck).toMatchObject({ renewal: result.renewal, expiresAt: result.grant.expiresAt });
  expect(result.saved).toEqual(result.atAck);
  const { deviceSecret, codeVerifier } = result.pollProof as { deviceSecret: string; codeVerifier: string };
  expect(result.ackProof).toEqual({ deviceSecret, codeVerifier });
});

test.each([
  [{ result: "legacy" }, "renewal_unavailable"],
  [{ result: "declined" }, "renewal_declined"],
  [{ result: "wallet" }, "renewal_wallet_unsupported"],
  [{ result: "grafted" }, "renewal_invalid_receipt"],
  [{ result: "over-ask" }, "renewal_invalid_receipt"],
  [{ result: "shifted-issued-at" }, "renewal_invalid_receipt"],
  [{ result: "no-extension" }, "renewal_no_extension"],
  [{ clock: "missing" }, "renewal_admission_expired"],
  [{ clock: "late" }, "renewal_admission_expired"],
  [{ clock: "late-in-transit" }, "renewal_admission_expired"],
  [{ clock: "future-issuance" }, "renewal_admission_expired"],
] satisfies [Fixture, string][])("%o saves only the independently verified grant", async (fixture, reason) => {
  const result = await run(fixture);
  expect(result.error).toBeUndefined();
  expect(result.value?.result).toMatchObject({ renewal: null, renewalReason: reason });
  expect(result.events).toEqual(["start", "poll", "ack"]);
  expect(result.atAck).toMatchObject({ ownerDid, expiresAt: result.grant.expiresAt });
  expect(result.atAck).not.toHaveProperty("renewal");
});

test.each([
  ["refuse-original", ["original"], "renewal_admission_failed"],
  ["wrong-original-cid", ["original"], "renewal_admission_failed"],
  ["wrong-identity", ["original", "identity"], "renewal_invalid_receipt"],
  ["refuse-lease", ["original", "identity", "lease"], "renewal_admission_failed"],
] as const)("%s saves the finite grant without a lease", async (node, operations, reason) => {
  const result = await run({ node });
  expect(result.value?.result).toMatchObject({ renewal: null, renewalReason: reason });
  expect(result.events).toEqual(["start", "poll", ...operations, "ack"]);
  expect(result.atAck).not.toHaveProperty("renewal");
});

test("cannot use a signed lease from a transaction that didn't ask for it", async () => {
  const result = await run({ ask: false });
  expect(result.start).not.toHaveProperty("renewal");
  expect(result.start).not.toHaveProperty("suggestedTtlSeconds");
  expect(result.events).toEqual(["start", "poll", "ack"]);
  expect(result.saved).not.toHaveProperty("renewal");
});

test("a bad base approval cannot admit any lease, save a session, or ACK", async () => {
  const result = await run({ result: "invalid-base" });
  expect(result.error).toMatchObject({ code: "DEVICE_AUTH_BINDING_MISMATCH" });
  expect(result.saved).toBeNull();
  expect(result.events).toEqual(["start", "poll"]);
});

test("the compare-and-commit loser neither saves nor ACKs its admitted lease", async () => {
  const result = await run({ loseCommit: true });
  expect(result.error).toMatchObject({ code: "PROFILE_CHANGED_DURING_LOGIN" });
  expect(result.events).toEqual(["start", "poll", "original", "identity", "lease"]);
  expect(result.saved).toEqual(result.previous);
  expect(result.saved).toHaveProperty("renewal");
});

test("the device login command asks for renewal by default and outputs metadata, never proof", async () => {
  const result = await run({ cliFlags: [] });
  expect(result.cli?.code).toBe(0);
  expect(result.start).toMatchObject({ renewal: { version: 1, leaseLifetimeSeconds: leaseSeconds }, delegationTtlSeconds: leaseSeconds, suggestedTtlSeconds: 604_800 });
  expect(JSON.parse(result.cli!.stdout)).toMatchObject({ authenticated: true, renewal: { leaseCid: result.renewal.receipt.leaseCid, leaseExpiresAt: result.renewal.receipt.leaseExpiresAt } });
  expect(result.cli!.stdout + result.cli!.stderr).not.toContain(result.renewal.receipt.leaseAuthorization);
});

test.each([
  [["--renew", "2d"], { renewal: { version: 1, leaseLifetimeSeconds: 172_800 }, suggestedTtlSeconds: 172_799 }, "renewal_unavailable"],
  [["--renew", "30d", "--expiry", "1h"], { renewal: { version: 1, leaseLifetimeSeconds: leaseSeconds }, delegationTtlSeconds: 3600 }, "renewal_unavailable"],
  [["--no-renew"], {}, undefined],
  [["--expiry", "30d"], {}, undefined],
] as const)("device login flag %j determines the ask without changing scope", async (flags, expected, reason) => {
  const result = await run({ cliFlags: [...flags], result: "legacy", clock: "missing" });
  expect(result.cli?.code).toBe(0);
  expect(result.events).toEqual(["start", "poll", "ack"]);
  expect(result.start).toMatchObject({ permissions: permissions.map((permission) => ({ ...permission, space: spaceId.toLowerCase() })), ...expected });
  if (!("renewal" in expected)) expect(result.start).not.toHaveProperty("renewal");
  if (!("suggestedTtlSeconds" in expected)) expect(result.start).not.toHaveProperty("suggestedTtlSeconds");
  const output = JSON.parse(result.cli!.stdout);
  if (reason) expect(output).toMatchObject({ renewal: null, renewalReason: reason });
  else expect(output).not.toHaveProperty("renewal");
});

test("an explicit lease that cannot extend the grant is rejected before OpenKey Start", async () => {
  const result = await run({ cliFlags: ["--expiry", "7d", "--renew", "7d"] });
  expect(result.cli?.code).toBe(2);
  expect(result.cli?.stderr).toContain("INVALID_RENEW");
  expect(result.events).toEqual([]);
});
