import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromEd25519PublicKey, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { DAY, MINUTE, OWNER_DID, APPLICATIONS, DEFAULT_SPACE, KV_PREFIX, SHARE_NETWORK, DEFAULT_NETWORK, cbor, recapResource, fakeOwner, rejects, type Tamper } from "./support/fake-owner.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "../src/index.js";
import type { AddressedOwnerRootInput } from "../src/addressed-publish.js";
import {
  ShareRoot,
  assertNonExtractableShareKey,
  createPolicyOwnerModeProbe,
  decodeOwnerRootCacao,
  ensureShareRoot,
  readPolicyOwnerAuthorityMode,
  type PolicyOwnerModeProbe,
} from "../src/share-root-entry.js";

const NODE = "https://node.example";
const LINK_PATH = "xyz.tinycloud.share/shares/abc/a.md";
const KV_PERMISSION = { service: "tinycloud.kv", path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] };
const DECRYPT_PERMISSION = { service: "tinycloud.encryption", path: SHARE_NETWORK, actions: ["tinycloud.encryption/decrypt"] };

/** A Node `/info` answering `body` (JSON) and recording each probe. */
function infoFetch(body: unknown, calls: string[] = []) {
  return async (input: URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}

/** `GET /info` as NODE-B2 §9 advertises it: the marker plus one mode in `features`. */
const info = (...extra: unknown[]) => ({ protocol: 1, version: "1.22.0", features: ["kv", "delegation", ...extra] });
const ENFORCING = ["policy-owner-authority-v1", "policy-owner-authority-enforce"];
const RECORDING = ["policy-owner-authority-v1", "policy-owner-authority-record"];

/** A probe whose answer the test switches. */
function switchableProbe(initial: boolean): PolicyOwnerModeProbe & { enforced: boolean; calls: number } {
  return { enforced: initial, calls: 0, async isEnforced() { this.calls++; return this.enforced; }, observe() {} };
}

function linkDid(): string {
  return didKeyFromEd25519PublicKey(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
}

interface CreateOptions {
  tamper?: Tamper;
  keyFactory?: () => Promise<DelegatedShareKey>;
  days?: number;
  kind?: "share" | "agent";
  spaceId?: string;
  nodeOrigin?: string;
  flag?: boolean;
  probe?: PolicyOwnerModeProbe;
  now?: () => number;
}

async function createRoot(options: CreateOptions = {}) {
  const owner = fakeOwner(options.tamper, options.now);
  const keys: DelegatedShareKey[] = [];
  const promise = ShareRoot.create({
    owner,
    spaceId: options.spaceId ?? (options.kind === "agent" ? DEFAULT_SPACE : APPLICATIONS),
    nodeOrigin: options.nodeOrigin ?? NODE,
    expiresAt: new Date((options.now ?? Date.now)() + (options.days ?? 37) * DAY),
    keyFactory: async () => { const key = await (options.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))(); keys.push(key); return key; },
    options: {
      kind: options.kind ?? "share",
      policyOwnerModeProbe: options.probe ?? switchableProbe(false),
      ...(options.flag === undefined ? {} : { shareRootPolicyRoots: options.flag }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  });
  return { owner, keys, promise };
}

const policyCapableRoot = (extra: CreateOptions = {}) => createRoot({ flag: true, probe: switchableProbe(true), ...extra });

describe("ShareRoot.create: scope follows the Node's advertised mode", () => {
  it("mints a kv-only root while the Node does not enforce, with one approval and the scope and node in the record", async () => {
    const { owner, keys, promise } = await createRoot({ flag: true });
    const root = await promise;
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]!.delegateDid).toBe(keys[0]!.did);
    expect(owner.calls[0]!.permissions).toEqual([KV_PERMISSION]);
    expect(root.scope).toBe("kv");
    expect(root.policyCapable).toBe(false);
    expect(root.toRecord()).toMatchObject({ scope: "kv", nodeOrigin: NODE, keyDid: keys[0]!.did });
    expect(JSON.stringify(root.toRecord())).not.toContain("privateKey");
    const restored = await ShareRoot.restore({ record: root.toRecord(), key: keys[0]! });
    expect(restored.cid).toBe(root.cid);
  });

  it.each([
    ["mode record", infoFetch(info(...RECORDING)), true, "kv"],
    ["no advertisement", infoFetch(info()), true, "kv"],
    ["an unreachable Node", async () => { throw new TypeError("fetch failed"); }, true, "kv"],
    ["mode enforce but the flag off", infoFetch(info(...ENFORCING)), false, "kv"],
    ["mode enforce and the flag on", infoFetch(info(...ENFORCING)), true, "kv+share-decrypt"],
  ] as [string, (input: URL) => Promise<Response>, boolean, string][])("with %s the root scope is chosen at creation", async (_case, fetchFn, flag, scope) => {
    const { owner, promise } = await createRoot({ flag, probe: createPolicyOwnerModeProbe({ fetch: fetchFn }) });
    const root = await promise;
    expect(root.scope).toBe(scope as "kv");
    expect(owner.calls[0]!.permissions).toEqual(scope === "kv" ? [KV_PERMISSION] : [KV_PERMISSION, DECRYPT_PERMISSION]);
  });

  it("agent roots are kv-only in the default space, even when the Node enforces", async () => {
    const { owner, promise } = await createRoot({ kind: "agent", days: 30, flag: true, probe: switchableProbe(true) });
    expect((await promise).scope).toBe("kv");
    expect(owner.calls[0]!.permissions).toEqual([KV_PERMISSION]);
  });

  it("refuses bad requests and unusable keys before asking the owner", async () => {
    for (const [options, code] of [
      [{ days: 38 }, "lifetime-exceeds-cap"],
      [{ kind: "agent", days: 31 }, "lifetime-exceeds-cap"],
      [{ spaceId: DEFAULT_SPACE }, "invalid-request"],
      [{ kind: "agent", spaceId: APPLICATIONS, days: 30 }, "invalid-request"],
      [{ spaceId: "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications" }, "invalid-request"],
      [{ nodeOrigin: "http://node.example" }, "invalid-request"],
      [{ nodeOrigin: "file:///tmp/node" }, "invalid-request"],
      [{ keyFactory: () => createDelegatedShareKey({ extractable: true }) }, "invalid-key"],
    ] as [CreateOptions, string][]) {
      const { owner, promise } = await createRoot(options);
      await rejects(promise, code);
      expect(owner.calls).toHaveLength(0);
    }
  });

  it("refuses a key that does not sign for its DID", async () => {
    const real = await createDelegatedShareKey({ extractable: false });
    const other = await createDelegatedShareKey({ extractable: false });
    const mismatched: DelegatedShareKey = { ...real, sign: (bytes) => other.sign(bytes) };
    await expect(assertNonExtractableShareKey(mismatched)).rejects.toThrow("does not sign for its DID");
    const { owner, promise } = await createRoot({ keyFactory: async () => mismatched });
    await rejects(promise, "invalid-key");
    expect(owner.calls).toHaveLength(0);
  });

  it.each([
    ["kv/put added to the prefix", { att: (att) => { att[KV_PREFIX]!["tinycloud.kv/put"] = [{}]; } }, "ability-mismatch", true],
    ["kv/list added to the prefix", { att: (att) => { att[KV_PREFIX]!["tinycloud.kv/list"] = [{}]; } }, "ability-mismatch", true],
    ["a caveat on kv/get", { att: (att) => { att[KV_PREFIX]!["tinycloud.kv/get"] = [{ prefix: "x" }]; } }, "ability-mismatch", true],
    ["kv/metadata dropped", { att: (att) => { delete att[KV_PREFIX]!["tinycloud.kv/metadata"]; } }, "ability-mismatch", true],
    [":share decrypt on a kv-only root", { att: (att) => { att[SHARE_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch", true],
    ["capabilities/read on the space", { att: (att) => { att[`${APPLICATIONS}/capabilities/all`] = { "tinycloud.capabilities/read": [{}] }; } }, "resource-mismatch", true],
    ["decrypt on :default", { att: (att) => { att[DEFAULT_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch", true],
    ["a kv path outside the prefix", { att: (att) => { att[`${APPLICATIONS}/kv/`] = { "tinycloud.kv/get": [{}] }; } }, "resource-mismatch", true],
    ["a non-ReCap SIWE resource", { extraResources: ["https://example.com/extra"] }, "resource-mismatch", true],
    ["two ReCap resources", { extraResources: [recapResource({ att: { [`${APPLICATIONS}/kv/`]: { "tinycloud.kv/put": [{}] } }, prf: [] })] }, "resource-mismatch", true],
    ["a parent capability", { prf: ["bafy-parent"] }, "resource-mismatch", true],
    ["another audience", { audience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }, "audience-mismatch", true],
    ["another owner", { issuer: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" }, "issuer-mismatch", true],
    ["a 40-day signed lifetime", { expiresAt: new Date(Date.now() + 40 * DAY) }, "lifetime-exceeds-cap", true],
    ["a forward-dated issue time with a matching long expiry", { issuedAt: new Date(Date.now() + 2 * DAY), expiresAt: new Date(Date.now() + 39 * DAY) }, "lifetime-exceeds-cap", true],
    ["an issue time back-dated beyond the skew", { issuedAt: new Date(Date.now() - 6 * MINUTE) }, "lifetime-exceeds-cap", true],
    ["a silently shortened expiry", { expiresAt: new Date(Date.now() + 30 * DAY) }, "expiry-mismatch", false],
    ["a future not-before", { notBefore: new Date(Date.now() + DAY) }, "malformed-root", false],
  ] as [string, Tamper, string, boolean][])("rejects a signed kv root with %s, clears the key and says whether to revoke", async (_case, tamper, code, mustRevoke) => {
    const { owner, keys, promise } = await createRoot({ tamper });
    const error = await rejects(promise, code);
    expect(owner.calls).toHaveLength(1);
    expect(error.rootCid).toBeString();
    expect(error.mustRevoke).toBe(mustRevoke);
    if (mustRevoke) expect(error.message).toContain(error.rootCid!);
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  it("rejects network.create on :share for a policy-capable root", async () => {
    const { promise } = await policyCapableRoot({ tamper: { att: (att) => { att[SHARE_NETWORK]!["tinycloud.encryption/network.create"] = [{}]; } } });
    expect((await rejects(promise, "ability-mismatch")).mustRevoke).toBe(true);
  });

  it("on a CID mismatch reports both the imported CID and the CID of the signed bytes", async () => {
    const imported = "bafkr4ibsw5yjl7ffzhpn53mf6h53yc7mozvvpifsg2jw7r4pzivjnrlrpa";
    const { promise } = await createRoot({ tamper: { cid: imported } });
    const error = await rejects(promise, "malformed-root");
    expect(error.rootCid).toBe(imported);
    expect(error.signedCid).toBeString();
    expect(error.signedCid).not.toBe(imported);
    expect(error.mustRevoke).toBe(true);
  });

  it("accepts a signer issue time up to 5 minutes before the request (skew)", async () => {
    const { promise } = await createRoot({ tamper: { issuedAt: new Date(Date.now() - 4 * MINUTE) } });
    expect((await promise).scope).toBe("kv");
  });
});

describe("decodeOwnerRootCacao strictness", () => {
  const valid = { h: { t: "eip4361" }, p: { domain: "d", iss: OWNER_DID, aud: "did:key:z", version: 1, nonce: "n", iat: new Date().toISOString(), resources: [recapResource({ att: {}, prf: [] })] }, s: { t: "eip191", s: new Uint8Array(65) } };

  it("rejects a duplicate CBOR map key", () => {
    const header = cbor({ t: "eip4361" });
    const duplicated = [0xa2, ...cbor("t"), ...cbor("eip4361"), ...cbor("t"), ...cbor("eip4361")];
    const bytes = Uint8Array.from(cbor(valid));
    const at = bytes.findIndex((_, index) => header.every((byte, offset) => bytes[index + offset] === byte));
    const patched = Uint8Array.from([...bytes.slice(0, at), ...duplicated, ...bytes.slice(at + header.length)]);
    expect(() => decodeOwnerRootCacao(Uint8Array.from(cbor(valid)))).not.toThrow();
    expect(() => decodeOwnerRootCacao(patched)).toThrow("CBOR map key is invalid");
  });

  it("rejects trailing bytes", () => {
    expect(() => decodeOwnerRootCacao(Uint8Array.from([...cbor(valid), 0x00]))).toThrow("trailing bytes");
  });

  it("rejects an unknown ReCap field", () => {
    const body = { ...valid, p: { ...valid.p, resources: [recapResource({ att: {}, prf: [], extra: true })] } };
    expect(() => decodeOwnerRootCacao(Uint8Array.from(cbor(body)))).toThrow("ReCap has an unknown field");
  });
});

describe("ShareRoot.restore and clear", () => {
  it("rejects expired, foreign-key and scope-mismatched records", async () => {
    const { keys, promise } = await createRoot({ days: 1 });
    const record = (await promise).toRecord();
    await rejects(ShareRoot.restore({ record, key: keys[0]!, options: { now: () => Date.now() + 2 * DAY } }), "expired");
    await rejects(ShareRoot.restore({ record, key: await createDelegatedShareKey({ extractable: false }) }), "audience-mismatch");
    await rejects(ShareRoot.restore({ record: { ...record, kind: "agent", spaceId: DEFAULT_SPACE }, key: keys[0]! }), "resource-mismatch");
    await rejects(ShareRoot.restore({ record: { ...record, scope: "kv+share-decrypt" }, key: keys[0]! }), "resource-mismatch");
    await rejects(ShareRoot.restore({ record: { ...record, nodeOrigin: "http://node.example" }, key: keys[0]! }), "invalid-request");

    const policyCreated = await policyCapableRoot();
    const policyRecord = (await policyCreated.promise).toRecord();
    expect(policyRecord.scope).toBe("kv+share-decrypt");
    expect((await ShareRoot.restore({ record: policyRecord, key: policyCreated.keys[0]! })).policyCapable).toBe(true);
    await rejects(ShareRoot.restore({ record: { ...policyRecord, scope: "kv" }, key: policyCreated.keys[0]! }), "resource-mismatch");
  });

  it("clear() destroys the only key handle: the root and the key stop signing", async () => {
    const { keys, promise } = await policyCapableRoot();
    const root = await promise;
    const signer = await root.policyRootSigner();
    root.clear();
    await rejects(root.signBearerLink({ linkDid: linkDid(), path: LINK_PATH, expiresAt: new Date(Date.now() + DAY) }), "key-cleared");
    await rejects(signer.sign(new Uint8Array(32)), "key-cleared");
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
    expect(root.covers(new Date(Date.now() + DAY))).toBe(false);
  });
});

describe("ShareRoot.signBearerLink", () => {
  it("signs kv/get on one exact key with the root as its only proof", async () => {
    const { keys, promise } = await createRoot();
    const root = await promise;
    const did = linkDid();
    const link = await root.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(Date.now() + 7 * DAY) });
    const verified = verifyCompactUcanAuthorization(link.delegation.authorization, link.delegation.cid);
    expect(verified.payload.iss.split("#")[0]).toBe(keys[0]!.did);
    expect(verified.payload.aud).toBe(did);
    expect(verified.payload.prf).toEqual([root.cid]);
    expect(verified.payload.att).toEqual({ [`${APPLICATIONS}/kv/${LINK_PATH}`]: { "tinycloud.kv/get": [{}] } });
    expect(verified.payload.exp).toBeLessThanOrEqual(Math.floor(root.expiresAt.getTime() / 1000));
  });

  it("refuses links outside the prefix, beyond the root, beyond 30 days, or after expiry", async () => {
    const root = await (await createRoot({ days: 20 })).promise;
    const did = linkDid();
    const week = new Date(Date.now() + 7 * DAY);
    for (const path of ["xyz.tinycloud.share/shares/", "xyz.tinycloud.share/shares/a/", "xyz.tinycloud.other/a.md", "xyz.tinycloud.share/shares/../x", "xyz.tinycloud.share/shares/*"]) {
      await rejects(root.signBearerLink({ linkDid: did, path, expiresAt: week }), "link-out-of-scope");
    }
    await rejects(root.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(Date.now() + 21 * DAY) }), "lifetime-exceeds-cap");
    await rejects(root.signBearerLink({ linkDid: root.keyDid, path: LINK_PATH, expiresAt: week }), "invalid-request");
    const long = await (await createRoot()).promise;
    await rejects(long.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(Date.now() + 31 * DAY) }), "lifetime-exceeds-cap");

    let clock = Date.now();
    const clocked = await (await createRoot({ days: 2, now: () => clock })).promise;
    clock += 3 * DAY;
    await rejects(clocked.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(clock + DAY) }), "expired");
  });
});

const ownerRootInput = (root: ShareRoot, overrides: Partial<AddressedOwnerRootInput> = {}): AddressedOwnerRootInput => ({
  ownerDid: root.keyDid,
  role: "policy-enforcement",
  audienceDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  policyId: "pol_abc",
  policyDigestHex: "a".repeat(64),
  policyCid: "bafkpolicy",
  contentSourceDigestHex: "b".repeat(64),
  capabilityCeilingHashHex: "c".repeat(64),
  nativeProjectionHashHex: "d".repeat(64),
  notBefore: new Date(Date.now() - MINUTE),
  expiresAt: new Date(Date.now() + 7 * DAY),
  nodeAudience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  capabilities: [
    { kind: "kv", resource: `${APPLICATIONS}/kv/xyz.tinycloud.share/shares/abc/a.md`, selector: "exact", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] },
    { kind: "encryption", resource: SHARE_NETWORK, action: "tinycloud.encryption/decrypt" },
  ],
  ...overrides,
});

describe("ShareRoot.policyRootSigner", () => {
  it("refuses with the flag off, without probing the Node", async () => {
    const probe = switchableProbe(true);
    const root = await (await createRoot({ probe })).promise;
    await rejects(root.policyRootSigner(), "policy-roots-disabled");
    expect(probe.calls).toBe(0);
  });

  it("refuses a kv-only root even when the Node enforces later", async () => {
    const probe = switchableProbe(false);
    const root = await (await createRoot({ flag: true, probe })).promise;
    probe.enforced = true;
    await rejects(root.policyRootSigner(), "root-not-policy-capable");
  });

  it("signs a typed policy root bound to the share root, and only 32-byte digests", async () => {
    const root = await (await policyCapableRoot({ days: 10 })).promise;
    const signer = await root.policyRootSigner();
    expect(signer.ownerDid).toBe(root.keyDid);
    expect(signer.notAfter.getTime()).toBe(root.expiresAt.getTime());
    const receipt = await signer.createOwnerRoot(ownerRootInput(root));
    const verified = verifyCompactUcanAuthorization(receipt.delegationHeader.Authorization, receipt.cid);
    expect(verified.payload.iss.split("#")[0]).toBe(root.keyDid);
    expect(verified.payload.prf).toEqual([]);
    expect(verified.payload.fct[0]).toMatchObject({ role: "policy-enforcement", mode: "conditional-mint", ownerDid: root.keyDid, enforcerDid: ownerRootInput(root).audienceDid });
    expect(Object.keys(verified.payload.att).sort()).toEqual([`${APPLICATIONS}/kv/xyz.tinycloud.share/shares/abc/a.md`, SHARE_NETWORK].sort());
    expect(await signer.sign(new Uint8Array(32))).toHaveLength(64);

    await rejects(signer.createOwnerRoot(ownerRootInput(root, { expiresAt: new Date(Date.now() + 11 * DAY) })), "lifetime-exceeds-cap");
    await rejects(signer.createOwnerRoot(ownerRootInput(root, { ownerDid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" })), "invalid-request");
    await rejects(signer.createOwnerRoot(ownerRootInput(root, { capabilities: [{ kind: "encryption", resource: DEFAULT_NETWORK, action: "tinycloud.encryption/decrypt" }] })), "invalid-request");
    await rejects(signer.createOwnerRoot(ownerRootInput(root, { capabilities: [{ kind: "kv", resource: `${APPLICATIONS}/kv/xyz.tinycloud.share/shares/abc/a.md`, selector: "exact", actions: ["tinycloud.kv/put"] }] })), "invalid-request");
    await rejects(signer.createOwnerRoot(ownerRootInput(root, { capabilities: [{ kind: "kv", resource: `${APPLICATIONS}/kv/other/a.md`, selector: "exact", actions: ["tinycloud.kv/get"] }] })), "invalid-request");
    await rejects(signer.sign(new Uint8Array(64)), "invalid-request");
  });

  it("re-checks the gate on every call: a Node that falls back to record stops a signer already handed out", async () => {
    const probe = switchableProbe(true);
    const root = await (await policyCapableRoot({ probe })).promise;
    const signer = await root.policyRootSigner();
    await signer.sign(new Uint8Array(32));
    probe.enforced = false;
    await rejects(signer.sign(new Uint8Array(32)), "policy-roots-not-enforced-by-node");
    await rejects(signer.createOwnerRoot(ownerRootInput(root)), "policy-roots-not-enforced-by-node");
    probe.enforced = true;
    await expect(signer.sign(new Uint8Array(32))).resolves.toHaveLength(64);
  });

  it("re-reads the advertised mode once the 5-minute cache expires", async () => {
    let features = ENFORCING;
    let clock = Date.now();
    const probes: string[] = [];
    const probe = createPolicyOwnerModeProbe({ fetch: async (input) => { probes.push(String(input)); return new Response(JSON.stringify(info(...features)), { headers: { "content-type": "application/json" } }); }, now: () => clock });
    const root = await (await createRoot({ flag: true, probe, now: () => clock })).promise;
    expect(root.scope).toBe("kv+share-decrypt");
    const signer = await root.policyRootSigner();
    features = RECORDING;
    clock += 4 * MINUTE;
    await expect(signer.sign(new Uint8Array(32))).resolves.toHaveLength(64);
    clock += 2 * MINUTE;
    await rejects(signer.sign(new Uint8Array(32)), "policy-roots-not-enforced-by-node");
    expect(probes).toHaveLength(2);
  });

  it("stops signing once the share root expires", async () => {
    let clock = Date.now();
    const root = await (await policyCapableRoot({ days: 2, now: () => clock })).promise;
    const signer = await root.policyRootSigner();
    clock += 3 * DAY;
    await rejects(signer.sign(new Uint8Array(32)), "expired");
    await rejects(root.policyRootSigner(), "expired");
  });

  it("agent roots are bearer-only", async () => {
    const agent = await (await createRoot({ kind: "agent", days: 30, flag: true, probe: switchableProbe(true) })).promise;
    await rejects(agent.policyRootSigner(), "policy-roots-disabled");
  });
});

describe("policy-owner mode probe", () => {
  it.each([
    ["mode record", infoFetch(info(...RECORDING))],
    ["no marker (every Node up to 1.21.0)", infoFetch(info())],
    ["the enforce mode without the marker", infoFetch(info("policy-owner-authority-enforce"))],
    ["both modes at once", infoFetch(info(...ENFORCING, "policy-owner-authority-record"))],
    ["a differently cased mode", infoFetch(info("policy-owner-authority-v1", "policy-owner-authority-ENFORCE"))],
    ["a malformed features value", infoFetch({ features: "policy-owner-authority-v1 policy-owner-authority-enforce" })],
    ["an unreachable Node", async () => { throw new TypeError("fetch failed"); }],
    ["a failing Node", async () => new Response(JSON.stringify(info(...ENFORCING)), { status: 503, headers: { "content-type": "application/json" } })],
    ["a non-JSON content type", async () => new Response(JSON.stringify(info(...ENFORCING)), { headers: { "content-type": "text/html" } })],
    ["an answer over 64 KiB", async () => new Response(JSON.stringify({ ...info(...ENFORCING), pad: "x".repeat(70_000) }), { headers: { "content-type": "application/json" } })],
  ] as [string, (input: URL) => Promise<Response>][])("%s is not enforcing", async (_case, fetchFn) => {
    expect(await createPolicyOwnerModeProbe({ fetch: fetchFn }).isEnforced(NODE)).toBe(false);
  });

  it("mode enforce is enforcing", async () => {
    expect(await createPolicyOwnerModeProbe({ fetch: infoFetch(info(...ENFORCING)) }).isEnforced(NODE)).toBe(true);
  });

  it("probes only https (http on loopback) and never caches opaque origins", async () => {
    const probes: string[] = [];
    const probe = createPolicyOwnerModeProbe({ fetch: infoFetch(info(...ENFORCING), probes) });
    expect(await probe.isEnforced("http://node.example")).toBe(false);
    expect(await probe.isEnforced("http://127.0.0.1:9000")).toBe(true);
    probe.observe("file:///a", ["kv", ...ENFORCING]);
    expect(await probe.isEnforced("data:text/plain,x")).toBe(false);
    expect(await probe.isEnforced("file:///a")).toBe(false);
    expect(probes).toEqual(["http://127.0.0.1:9000/info"]);
  });

  it("caches per Node for at most 5 minutes and takes sign-in features without a fetch", async () => {
    let features = ENFORCING;
    let clock = 1_000_000;
    const probes: string[] = [];
    const probe = createPolicyOwnerModeProbe({ fetch: async (input) => { probes.push(String(input)); return new Response(JSON.stringify(info(...features)), { headers: { "content-type": "application/json" } }); }, ttlMs: 60 * MINUTE, now: () => clock });
    expect(await probe.isEnforced(NODE)).toBe(true);
    features = RECORDING;
    clock += 4 * MINUTE;
    expect(await probe.isEnforced(`${NODE}/some/path`)).toBe(true);
    clock += 61_000; // past the 5-minute ceiling even though 60 minutes were asked for
    expect(await probe.isEnforced(NODE)).toBe(false);
    expect(await probe.isEnforced("https://other-node.example")).toBe(false);
    expect(probes).toHaveLength(3);
    probe.observe(NODE, ["kv", ...ENFORCING]);
    expect(await probe.isEnforced(NODE)).toBe(true);
    expect(probes).toHaveLength(3);
  });

  it("readPolicyOwnerAuthorityMode reads only the NODE-B2 feature strings", () => {
    expect(readPolicyOwnerAuthorityMode(ENFORCING)).toBe("enforce");
    expect(readPolicyOwnerAuthorityMode(RECORDING)).toBe("record");
    for (const value of [[], ["kv"], ["policy-owner-authority-enforce"], [...ENFORCING, "policy-owner-authority-record"], undefined, null, "policy-owner-authority-enforce", { 0: "x" }]) {
      expect(readPolicyOwnerAuthorityMode(value)).toBeUndefined();
    }
  });
});

describe("ensureShareRoot", () => {
  const base = { spaceId: APPLICATIONS, nodeOrigin: NODE };

  it("keeps a covering root, and re-roots once with a new key and the cap minus the margin when it does not cover", async () => {
    const owner = fakeOwner();
    const probe = switchableProbe(false);
    const first = await ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + 7 * DAY), owner, options: { policyOwnerModeProbe: probe } });
    expect(first.rerooted).toBe(true);
    expect(owner.calls).toHaveLength(1);
    const requested = owner.calls[0]!.expiresAt.getTime() - Date.now();
    expect(requested).toBeLessThanOrEqual(37 * DAY - 10 * MINUTE);
    expect(requested).toBeGreaterThan(37 * DAY - 11 * MINUTE);

    const kept = await ensureShareRoot({ ...base, current: first.root, expiresAt: new Date(Date.now() + 30 * DAY), owner, options: { policyOwnerModeProbe: probe } });
    expect(kept).toEqual({ root: first.root, rerooted: false });
    expect(owner.calls).toHaveLength(1);

    const later = () => Date.now() + 10 * DAY;
    const rerooted = await ensureShareRoot({ ...base, current: first.root, expiresAt: new Date(later() + 30 * DAY), owner: fakeOwner({}, later), options: { now: later, policyOwnerModeProbe: probe } });
    expect(rerooted.rerooted).toBe(true);
    expect(rerooted.root.keyDid).not.toBe(first.root.keyDid);
    await rejects(ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + 31 * DAY), owner, options: { policyOwnerModeProbe: probe } }), "lifetime-exceeds-cap");
  });

  it("refuses to reuse the current key for a re-root, before asking the owner", async () => {
    const keys: DelegatedShareKey[] = [];
    const keyFactory = async () => { const key = await createDelegatedShareKey({ extractable: false }); keys.push(key); return key; };
    const first = await ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + DAY), owner: fakeOwner(), keyFactory });
    const owner = fakeOwner();
    const later = () => Date.now() + 10 * DAY;
    await rejects(ensureShareRoot({ ...base, current: first.root, expiresAt: new Date(later() + 30 * DAY), owner, keyFactory: async () => keys[0]!, options: { now: later } }), "reroot-same-key");
    expect(owner.calls).toHaveLength(0);
  });

  it("for policy: kv-only + not enforcing refuses without a prompt; kv-only + enforcing re-roots with decrypt; a policy-capable root is kept", async () => {
    const probe = switchableProbe(false);
    const options = { shareRootPolicyRoots: true, policyOwnerModeProbe: probe };
    const owner = fakeOwner();
    const bearer = await ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + 7 * DAY), owner, options });
    expect(bearer.root.scope).toBe("kv");

    await rejects(ensureShareRoot({ ...base, current: bearer.root, purpose: "policy", expiresAt: new Date(Date.now() + 7 * DAY), owner, options }), "policy-roots-not-enforced-by-node");
    expect(owner.calls).toHaveLength(1);

    probe.enforced = true;
    const policy = await ensureShareRoot({ ...base, current: bearer.root, purpose: "policy", expiresAt: new Date(Date.now() + 7 * DAY), owner, options });
    expect(policy.rerooted).toBe(true);
    expect(policy.root.scope).toBe("kv+share-decrypt");
    expect(owner.calls[1]!.permissions).toEqual([KV_PERMISSION, DECRYPT_PERMISSION]);

    const kept = await ensureShareRoot({ ...base, current: policy.root, purpose: "policy", expiresAt: new Date(Date.now() + 7 * DAY), owner, options });
    expect(kept.rerooted).toBe(false);
    const bearerReuse = await ensureShareRoot({ ...base, current: policy.root, expiresAt: new Date(Date.now() + 7 * DAY), owner, options });
    expect(bearerReuse.rerooted).toBe(false);
    expect(owner.calls).toHaveLength(2);

    await rejects(ensureShareRoot({ ...base, purpose: "policy", expiresAt: new Date(Date.now() + DAY), owner, options: { policyOwnerModeProbe: probe } }), "policy-roots-disabled");
  });
});
