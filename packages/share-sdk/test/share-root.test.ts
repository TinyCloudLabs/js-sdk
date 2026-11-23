import { describe, expect, it } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromEd25519PublicKey, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { DAY, MINUTE, OWNER_DID, APPLICATIONS, DEFAULT_SPACE, KV_PREFIX, SHARE_NETWORK, DEFAULT_NETWORK, cbor, recapResource, fakeOwner, rejects, type Tamper } from "./support/fake-owner.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "../src/index.js";
import { ShareRoot, assertNonExtractableShareKey, decodeOwnerRootCacao, ensureShareRoot } from "../src/share-root-entry.js";

const NODE = "https://node.example";
const LINK_PATH = "xyz.tinycloud.share/shares/abc/a.md";
const KV_PERMISSION = { service: "tinycloud.kv", path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] };

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
    options: { kind: options.kind ?? "share", ...(options.now === undefined ? {} : { now: options.now }) },
  });
  return { owner, keys, promise };
}

describe("ShareRoot.create", () => {
  it("asks for kv get + metadata on the share prefix only, with one approval, and records the node", async () => {
    const { owner, keys, promise } = await createRoot();
    const root = await promise;
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]!.delegateDid).toBe(keys[0]!.did);
    expect(owner.calls[0]!.permissions).toEqual([KV_PERMISSION]);
    expect(root.toRecord()).toMatchObject({ version: 1, kind: "share", nodeOrigin: NODE, keyDid: keys[0]!.did });
    expect(JSON.stringify(root.toRecord())).not.toContain("privateKey");
    const restored = await ShareRoot.restore({ record: root.toRecord(), key: keys[0]! });
    expect(restored.cid).toBe(root.cid);
  });

  it("agent roots are kv-only in the default space", async () => {
    const { owner, promise } = await createRoot({ kind: "agent", days: 30 });
    expect((await promise).kind).toBe("agent");
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
    [":share decrypt", { att: (att) => { att[SHARE_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch", true],
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
    ["kv/metadata dropped (narrower)", { att: (att) => { delete att[KV_PREFIX]!["tinycloud.kv/metadata"]; } }, "ability-mismatch", false],
    ["the prefix dropped (narrower)", { att: (att) => { delete att[KV_PREFIX]; } }, "resource-mismatch", false],
    ["a silently shortened expiry", { expiresAt: new Date(Date.now() + 30 * DAY) }, "expiry-mismatch", false],
    ["a future not-before", { notBefore: new Date(Date.now() + DAY) }, "malformed-root", false],
  ] as [string, Tamper, string, boolean][])("rejects a signed root with %s, clears the key and says whether to revoke", async (_case, tamper, code, mustRevoke) => {
    const { owner, keys, promise } = await createRoot({ tamper });
    const error = await rejects(promise, code);
    expect(owner.calls).toHaveLength(1);
    expect(error.rootCid).toBeString();
    expect(error.mustRevoke).toBe(mustRevoke);
    if (mustRevoke) expect(error.message).toContain(error.rootCid!);
    else expect(error.message).not.toContain("must revoke");
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
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
    expect((await promise).issuedAt.getTime()).toBeLessThan(Date.now());
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
  it("rejects expired, foreign-key, kind-mismatched and non-https records", async () => {
    const { keys, promise } = await createRoot({ days: 1 });
    const record = (await promise).toRecord();
    await rejects(ShareRoot.restore({ record, key: keys[0]!, options: { now: () => Date.now() + 2 * DAY } }), "expired");
    await rejects(ShareRoot.restore({ record, key: await createDelegatedShareKey({ extractable: false }) }), "audience-mismatch");
    await rejects(ShareRoot.restore({ record: { ...record, kind: "agent", spaceId: DEFAULT_SPACE }, key: keys[0]! }), "resource-mismatch");
    await rejects(ShareRoot.restore({ record: { ...record, nodeOrigin: "http://node.example" }, key: keys[0]! }), "invalid-request");
  });

  it("clear() destroys the only key handle: the root stops signing", async () => {
    const { keys, promise } = await createRoot();
    const root = await promise;
    root.clear();
    await rejects(root.signBearerLink({ linkDid: linkDid(), path: LINK_PATH, expiresAt: new Date(Date.now() + DAY) }), "key-cleared");
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

describe("ensureShareRoot", () => {
  const base = { spaceId: APPLICATIONS, nodeOrigin: NODE };

  it("keeps a covering root, and re-roots once with a new key and the cap minus the margin when it does not cover", async () => {
    const owner = fakeOwner();
    const first = await ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + 7 * DAY), owner });
    expect(first.rerooted).toBe(true);
    expect(owner.calls).toHaveLength(1);
    const requested = owner.calls[0]!.expiresAt.getTime() - Date.now();
    expect(requested).toBeLessThanOrEqual(37 * DAY - 10 * MINUTE);
    expect(requested).toBeGreaterThan(37 * DAY - 11 * MINUTE);

    const kept = await ensureShareRoot({ ...base, current: first.root, expiresAt: new Date(Date.now() + 30 * DAY), owner });
    expect(kept).toEqual({ root: first.root, rerooted: false });
    expect(owner.calls).toHaveLength(1);

    const later = () => Date.now() + 10 * DAY;
    const rerooted = await ensureShareRoot({ ...base, current: first.root, expiresAt: new Date(later() + 30 * DAY), owner: fakeOwner({}, later), options: { now: later } });
    expect(rerooted.rerooted).toBe(true);
    expect(rerooted.root.keyDid).not.toBe(first.root.keyDid);
    await rejects(ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + 31 * DAY), owner }), "lifetime-exceeds-cap");
  });

  it("re-roots for another node or kind instead of reusing the current root", async () => {
    const owner = fakeOwner();
    const first = await ensureShareRoot({ ...base, expiresAt: new Date(Date.now() + DAY), owner });
    expect((await ensureShareRoot({ ...base, nodeOrigin: "https://other.example", current: first.root, expiresAt: new Date(Date.now() + DAY), owner })).rerooted).toBe(true);
    expect((await ensureShareRoot({ spaceId: DEFAULT_SPACE, nodeOrigin: NODE, current: first.root, expiresAt: new Date(Date.now() + DAY), owner, options: { kind: "agent" } })).rerooted).toBe(true);
    expect(owner.calls).toHaveLength(3);
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
});
