import { expect } from "bun:test";
import { createHash, createPrivateKey } from "node:crypto";
import { NodeWasmBindings, TinyCloudNode, ownerFullAccess, type PrivateKeySigner } from "@tinycloud/node-sdk";
import { activateSessionWithHost, principalDid } from "@tinycloud/sdk-core";
import { parseSignedUcan } from "@tinycloud/share-sdk/share-index";
import { KVService, ServiceContext } from "@tinycloud/sdk-services";
import { generateKey } from "../auth/local-key.js";
import { onboardingHandoff } from "../auth/onboarding-handoff.js";
import { onboardingPlan } from "../auth/onboarding-scope.js";

type HandoffRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
  offered: Array<{ request?: { targetDid: string }; delegation?: Record<string, unknown> }>;
};

async function verifyHandoffRoundTrip({ host, registryOrigin, ownerSigner, done, start, short, rerun }: {
  host: string;
  registryOrigin: string;
  ownerSigner: PrivateKeySigner;
  done: HandoffRun;
  start: number;
  short: boolean;
  rerun: () => Promise<void>;
}) {
  const result = JSON.parse(done.stdout);
  expect(result.onboarded === true).toBe(true);
  const url = result.handoff?.url;
  expect(typeof url === "string", "real handoff issued").toBe(true);
  if (typeof url !== "string") throw new Error("handoff was omitted");
  expect(/^https:\/\/tinycloud\.one\/handoff#tch1[0-9A-HJKMNP-TV-Z]+$/.test(url)).toBe(true);
  const fragment = url.slice(url.indexOf("#") + 5);
  expect(url.length).toBeLessThanOrEqual(1800);
  console.log(`${short ? "2h" : "30d"} parent: real signed handoff length ${url.length} chars`);
  expect(!done.stderr.includes(fragment) && done.stdout.split(url).length === 2, "secret appears in result only once").toBe(true);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes: number[] = [];
  let bits = 0;
  let pending = 0;
  for (const char of fragment) {
    pending = (pending << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) bytes.push((pending >>> (bits -= 8)) & 255);
  }
  expect((pending & ((1 << bits) - 1)) === 0, "canonical padding").toBe(true);
  const packed = Buffer.from(bytes);
  const ucan = packed.subarray(32).toString("ascii");
  const segments = ucan.split(".");
  const header = JSON.parse(Buffer.from(segments[0]!, "base64url").toString("utf8"));
  expect(header.typ === "JWT" && header.ucv === "0.10.0" && header.alg === "EdDSA" &&
    header.jwk?.kty === "OKP" && header.jwk?.crv === "Ed25519" && typeof header.jwk?.x === "string" && !("d" in header.jwk)).toBe(true);
  const proof = (() => {
    try { return parseSignedUcan(ucan); }
    catch { throw new Error("handoff proof verification failed"); }
  })();
  console.log(`signed handoff nbf: ${proof.notBefore ?? "absent"}`);
  const seed = packed.subarray(0, 32);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const jwk = key.export({ format: "jwk" });
  const parentCid = String(done.offered[0]!.delegation!.delegationCid);
  const issuer = principalDid(done.offered[0]!.request!.targetDid);
  const recordKey = `xyz.tinycloud.one/handoff/v1/${createHash("sha256").update(`${issuer}\n${parentCid}`).digest("hex").slice(0, 32)}`;
  const wasm = new NodeWasmBindings();
  const address = await ownerSigner.getAddress();
  const apps = wasm.makeSpaceId(address, 1, "applications");
  const account = wasm.makeSpaceId(address, 1, "account");
  const resource = Object.keys(proof.attenuation)[0]!;
  expect(Object.keys(proof.attenuation).length === 1 && resource.toLowerCase() === `${apps.toLowerCase()}/kv/${recordKey}`).toBe(true);
  expect(JSON.stringify(proof.attenuation[resource]) === '{"tinycloud.kv/get":[{}]}').toBe(true);
  expect(proof.issuer === issuer && proof.proofs.length === 1 && proof.proofs[0] === parentCid).toBe(true);
  expect(proof.facts?.some(fact => JSON.stringify(fact) === '{"xyz.tinycloud.policy/delegationMode":"terminal"}')).toBe(true);
  const signedParentExpiry = Date.parse(result.expiresAt);
  expect(Date.parse(result.handoff.expiresAt) === proof.expiresAt * 1000).toBe(true);
  if (short) expect(proof.expiresAt === Math.floor(signedParentExpiry / 1000)).toBe(true);
  else {
    expect(proof.expiresAt * 1000).toBeGreaterThanOrEqual(start + 86_400_000 - 1000);
    expect(proof.expiresAt * 1000).toBeLessThanOrEqual(Date.now() + 86_400_000);
  }
  const service = (spaceId: string) => {
    const kv = new KVService();
    kv.initialize(new ServiceContext({ hosts: [host], retryPolicy: { maxAttempts: 1 },
      invoke: wasm.invoke, invokeAny: wasm.invokeAny,
      session: { spaceId, delegationHeader: { Authorization: ucan }, delegationCid: proof.cid, verificationMethod: proof.audience, jwk },
    }));
    return kv;
  };
  const reader = service(resource.slice(0, resource.indexOf("/kv/")));
  const read = await reader.get(recordKey, { source: "network" });
  expect(read.ok, "recipient gets leaf from node").toBe(true);
  if (!read.ok) throw new Error("record read refused");
  expect(read.data.data).toMatchObject({
    version: 1, agent_name: "TinyCloud agent", access_expires_at: result.expiresAt,
    app_ids: ["Zed", "apple"], apps_truncated: false, abilities: ["apps_data", "account_index"],
  });
  expect(!JSON.stringify(read.data.data).includes("synthetic-registry-value")).toBe(true);
  expect((await reader.put(recordKey, "no")).ok).toBe(false);
  expect((await reader.get(`${recordKey}x`, { source: "network" })).ok).toBe(false);
  expect((await service(account).list({ prefix: "applications/", source: "network" })).ok).toBe(false);
  await rerun();
  expect((await reader.get(recordKey, { source: "network" })).ok).toBe(true);
  const owner = new TinyCloudNode({ host, tinycloudRegistryUrl: registryOrigin, signer: ownerSigner,
    ...ownerFullAccess(), autoBootstrapAccount: false, enablePublicSpace: false });
  await owner.signIn();
  const revocation = await owner.signOwnerRevocation(parentCid);
  const receipt = await fetch(`${host}/revoke`, { method: "POST", headers: { authorization: revocation } });
  expect(receipt.ok, "owner revokes parent at node").toBe(true);
  const refused = await reader.get(recordKey, { source: "network" });
  expect(!refused.ok && refused.error.code === "AUTH_UNAUTHORIZED", "node refuses child after parent revoke").toBe(true);
}

const NO_HANDOFF = "You're set up. Sign in at tinycloud.one to get started.";
type Fixture = {
  host: string;
  registryOrigin: string;
  ownerSigner: PrivateKeySigner;
  cli: (name: string, args: string[]) => Promise<{ exitCode: number; stdout: string }>;
  onboardWithApprovals: (name: string, signer: () => PrivateKeySigner, args?: string[]) => Promise<HandoffRun>;
};

function expectNoLink(stdout: string, message: string) {
  const { handoff } = JSON.parse(stdout);
  expect(handoff?.message === message && handoff?.url === undefined && !stdout.includes("https://tinycloud.one/handoff#")).toBe(true);
}

async function verifyOccupiedLeaf({ host, registryOrigin, ownerSigner, cli }: Fixture) {
  const wasm = new NodeWasmBindings();
  const address = await ownerSigner.getAddress();
  const spaceId = wasm.makeSpaceId(address, 1, "applications");
  const { permissions } = onboardingPlan();
  const { did, jwk } = generateKey();
  const spaceAbilities: Record<string, Record<string, Record<string, string[]>>> = {};
  for (const permission of permissions) {
    const space = wasm.makeSpaceId(address, 1, permission.space!);
    const byService = spaceAbilities[space] ??= {};
    (byService[permission.service.slice("tinycloud.".length)] ??= {})[permission.path] = permission.actions;
  }
  for (const abilities of Object.values(spaceAbilities)) {
    abilities.capabilities = { "": ["tinycloud.capabilities/read"] };
  }
  const now = Date.now();
  const prepared = wasm.prepareSession({
    abilities: spaceAbilities[spaceId], spaceAbilities, address, chainId: 1, domain: "cli.tinycloud.xyz",
    spaceId, jwk, issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + 7_200_000).toISOString(),
  });
  const signature = await ownerSigner.signMessage(prepared.siwe);
  const session = wasm.completeSessionSetup({ ...prepared, signature });
  expect((await activateSessionWithHost(host, session.delegationHeader)).success).toBe(true);
  const node = new TinyCloudNode({ host, tinycloudRegistryUrl: registryOrigin, autoBootstrapAccount: false });
  await node.restoreSession({ ...session, address, chainId: 1, spaceId, jwk, verificationMethod: did,
    siwe: prepared.siwe, signature, tinycloudHosts: [host] });
  const id = createHash("sha256").update(`${principalDid(did)}\n${session.delegationCid}`).digest("hex").slice(0, 32);
  const key = `xyz.tinycloud.one/handoff/v1/${id}`;
  expect((await cli("wallet", ["kv", "put", "--space", "applications", `${key}/private`, "synthetic-descendant"])).exitCode).toBe(0);
  const handoff = await onboardingHandoff(permissions, session.delegationCid, async () => node);
  expect("message" in handoff && handoff.message === NO_HANDOFF, "occupied descendant omits the handoff").toBe(true);
  expect((await cli("wallet", ["kv", "get", "--space", "applications", key])).exitCode, "occupied leaf was not written").toBe(4);
}

export async function verifyOnboardingHandoff(fixture: Fixture) {
  const { host, registryOrigin, ownerSigner, cli, onboardWithApprovals } = fixture;
  const info = await fetch(`${host}/info`);
  expect(info.status).toBe(200);
  const { version } = await info.json();
  if (typeof version === "string" && /^\d+\.\d+\.\d+(?:[-.a-zA-Z0-9]*)?$/.test(version)) console.log(`loopback GET /info: HTTP ${info.status}, ${version}`);
  for (const key of ["applications/Zed", "applications/apple", "applications/xyz.tinycloud.secrets", "applications/apple/descendant"]) {
    expect((await cli("wallet", ["kv", "put", "--space", "account", key, "synthetic-registry-value-not-for-handoff"])).exitCode).toBe(0);
  }
  for (const expiry of ["30d", "2h"]) {
    const name = `handoff-${expiry}`;
    const start = Date.now();
    const done = await onboardWithApprovals(name, () => ownerSigner, ["onboard", "--expiry", expiry]);
    expect(done.exitCode, "onboarding succeeds").toBe(0);
    expect(done.offered.length, "one approval").toBe(1);
    await verifyHandoffRoundTrip({
      host, registryOrigin, ownerSigner, done, start, short: expiry === "2h",
      rerun: async () => {
        const repeat = await onboardWithApprovals(name, () => { throw new Error("handoff rerun began another approval"); });
        expect(repeat.exitCode).toBe(0);
        expect(repeat.offered.length).toBe(0);
        expectNoLink(repeat.stdout, NO_HANDOFF);
      },
    });
  }
  const feed = await onboardWithApprovals("handoff-feed", () => ownerSigner, ["onboard", "--with", "feed"]);
  expect(feed.exitCode).toBe(0);
  expect(feed.offered.length).toBe(1);
  expectNoLink(feed.stdout, "Your Feed is set up. This setup doesn't give your agent access to your app list, so there's no setup link.");
  await verifyOccupiedLeaf(fixture);
}
