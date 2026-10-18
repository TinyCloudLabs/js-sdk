import { describe, expect, it } from "bun:test";
import { verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { APPLICATIONS, DAY, DEFAULT_NETWORK, DEFAULT_SPACE, MINUTE, SHARE_NETWORK, fakeOwner, rejects, type Tamper } from "./support/fake-owner.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "../src/index.js";
import type { AddressedOwnerRootInput } from "../src/addressed-publish.js";
import { ShareGrant, type ShareGrantAccess } from "../src/share-root-entry.js";

const NODE = "https://node.example";
const PATH = "xyz.tinycloud.share/shares/s1/a.md";
const RESOURCE = `${APPLICATIONS}/kv/${PATH}`;
const VIEW = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
const EDIT = [...VIEW, "tinycloud.kv/put"];
const DECRYPT = { service: "tinycloud.encryption", path: SHARE_NETWORK, actions: ["tinycloud.encryption/decrypt"] };

interface GrantOptions {
  tamper?: Tamper;
  path?: string;
  access?: ShareGrantAccess;
  days?: number;
  spaceId?: string;
  nodeOrigin?: string;
  keyFactory?: () => Promise<DelegatedShareKey>;
  now?: () => number;
}

async function createGrant(options: GrantOptions = {}) {
  const owner = fakeOwner(options.tamper, options.now);
  const keys: DelegatedShareKey[] = [];
  const promise = ShareGrant.create({
    owner,
    spaceId: options.spaceId ?? APPLICATIONS,
    nodeOrigin: options.nodeOrigin ?? NODE,
    path: options.path ?? PATH,
    access: options.access ?? "view",
    expiresAt: new Date((options.now ?? Date.now)() + (options.days ?? 7) * DAY),
    keyFactory: async () => { const key = await (options.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))(); keys.push(key); return key; },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { owner, keys, promise };
}

const rootInput = (grant: ShareGrant, overrides: Partial<AddressedOwnerRootInput> = {}): AddressedOwnerRootInput => ({
  ownerDid: grant.keyDid,
  role: "policy-authority",
  audienceDid: "did:tinycloud:policy:abc",
  policyId: "pol_abc",
  policyDigestHex: "a".repeat(64),
  policyCid: "bafkpolicy",
  contentSourceDigestHex: "b".repeat(64),
  capabilityCeilingHashHex: "c".repeat(64),
  nativeProjectionHashHex: "d".repeat(64),
  notBefore: new Date(Date.now() - MINUTE),
  expiresAt: new Date(Date.now() + 5 * DAY),
  nodeAudience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  capabilities: [
    { kind: "kv", resource: RESOURCE, selector: "exact", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] },
    { kind: "encryption", resource: SHARE_NETWORK, action: "tinycloud.encryption/decrypt" },
  ],
  ...overrides,
});

describe("ShareGrant.create", () => {
  it.each([["view", VIEW], ["edit", EDIT]] as [ShareGrantAccess, string[]][])("a %s grant asks one approval for exactly one key plus :share decrypt, to a fresh key", async (access, actions) => {
    const { owner, keys, promise } = await createGrant({ access });
    const grant = await promise;
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]!.delegateDid).toBe(keys[0]!.did);
    expect(owner.calls[0]!.permissions).toEqual([{ service: "tinycloud.kv", path: PATH, actions }, DECRYPT]);
    expect(grant.resource).toBe(RESOURCE);
    expect(grant.toRecord()).toMatchObject({ path: PATH, access, keyDid: keys[0]!.did, nodeOrigin: NODE });
    expect(JSON.stringify(grant.toRecord())).not.toContain("privateKey");
    expect((await ShareGrant.restore({ record: grant.toRecord(), key: keys[0]! })).cid).toBe(grant.cid);
  });

  it("refuses broader paths, longer expiries, other spaces, other access and unusable keys before the wallet prompt", async () => {
    for (const [options, code] of [
      [{ path: "xyz.tinycloud.share/shares/" }, "link-out-of-scope"],
      [{ path: "xyz.tinycloud.share/shares/s1/" }, "link-out-of-scope"],
      [{ path: "xyz.tinycloud.share/shares/s1/*" }, "link-out-of-scope"],
      [{ path: "xyz.tinycloud.share/shares/../secrets/x" }, "link-out-of-scope"],
      [{ path: "xyz.tinycloud.other/a.md" }, "link-out-of-scope"],
      [{ days: 31 }, "lifetime-exceeds-cap"],
      [{ days: -1 }, "invalid-request"],
      [{ spaceId: DEFAULT_SPACE }, "invalid-request"],
      [{ access: "list" as ShareGrantAccess }, "invalid-request"],
      [{ nodeOrigin: "http://node.example" }, "invalid-request"],
      [{ keyFactory: () => createDelegatedShareKey({ extractable: true }) }, "invalid-key"],
    ] as [GrantOptions, string][]) {
      const { owner, promise } = await createGrant(options);
      await rejects(promise, code);
      expect(owner.calls).toHaveLength(0);
    }
  });

  it.each([
    ["the whole prefix instead of the key", { att: (att) => { att[`${APPLICATIONS}/kv/xyz.tinycloud.share/shares/`] = att[RESOURCE]!; delete att[RESOURCE]; } }, "resource-mismatch"],
    ["kv/put on a view grant", { att: (att) => { att[RESOURCE]!["tinycloud.kv/put"] = [{}]; } }, "ability-mismatch"],
    ["kv/list on the key", { att: (att) => { att[RESOURCE]!["tinycloud.kv/list"] = [{}]; } }, "ability-mismatch"],
    ["no :share decrypt", { att: (att) => { delete att[SHARE_NETWORK]; } }, "resource-mismatch"],
    ["decrypt on :default", { att: (att) => { att[DEFAULT_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch"],
    ["another audience", { audience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }, "audience-mismatch"],
    ["a 31-day signed expiry", { expiresAt: new Date(Date.now() + 31 * DAY) }, "lifetime-exceeds-cap"],
    ["a longer signed expiry within the cap", { expiresAt: new Date(Date.now() + 9 * DAY) }, "expiry-mismatch"],
    ["a parent capability", { prf: ["bafy-parent"] }, "resource-mismatch"],
  ] as [string, Tamper, string][])("rejects a signed grant with %s, clears the key and asks for a revoke", async (_case, tamper, code) => {
    const { keys, promise } = await createGrant({ tamper });
    const error = await rejects(promise, code);
    expect(error.mustRevoke).toBe(true);
    expect(error.message).toContain(error.rootCid!);
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  it("restore refuses a record whose access or path differs from what was signed", async () => {
    const { keys, promise } = await createGrant();
    const record = (await promise).toRecord();
    await rejects(ShareGrant.restore({ record: { ...record, access: "edit" }, key: keys[0]! }), "ability-mismatch");
    await rejects(ShareGrant.restore({ record: { ...record, path: "xyz.tinycloud.share/shares/s1/b.md" }, key: keys[0]! }), "resource-mismatch");
    await rejects(ShareGrant.restore({ record, key: await createDelegatedShareKey({ extractable: false }) }), "audience-mismatch");
  });
});

describe("ShareGrant.policySigner", () => {
  it("signs this share's policy roots, owned by the per-share key and bounded by the grant", async () => {
    const grant = await (await createGrant()).promise;
    const signer = grant.policySigner();
    expect(signer.ownerDid).toBe(grant.keyDid);
    expect(signer.rootCid).toBe(grant.cid);
    const receipt = await signer.createOwnerRoot(rootInput(grant));
    const verified = verifyCompactUcanAuthorization(receipt.delegationHeader.Authorization, receipt.cid);
    expect(verified.payload.iss.split("#")[0]).toBe(grant.keyDid);
    expect(verified.payload.prf).toEqual([]);
    expect(Object.keys(verified.payload.att).sort()).toEqual([RESOURCE, SHARE_NETWORK].sort());
    expect(await signer.sign(new Uint8Array(32))).toHaveLength(64);
    expect(grant.publishAuthority(async () => { throw new Error("not called"); }).ownerDid).toBe(grant.keyDid);
  });

  it("refuses roots for another key, a wider selector, an action the grant lacks, another network or a later expiry", async () => {
    const grant = await (await createGrant()).promise;
    const signer = grant.policySigner();
    for (const capabilities of [
      [{ kind: "kv", resource: `${APPLICATIONS}/kv/xyz.tinycloud.share/shares/s1/b.md`, selector: "exact", actions: ["tinycloud.kv/get"] }],
      [{ kind: "kv", resource: RESOURCE, selector: "prefix", actions: ["tinycloud.kv/get"] }],
      [{ kind: "kv", resource: RESOURCE, selector: "exact", actions: ["tinycloud.kv/put"] }],
      [{ kind: "encryption", resource: DEFAULT_NETWORK, action: "tinycloud.encryption/decrypt" }],
    ] as AddressedOwnerRootInput["capabilities"][]) {
      await rejects(signer.createOwnerRoot(rootInput(grant, { capabilities })), "invalid-request");
    }
    await rejects(signer.createOwnerRoot(rootInput(grant, { expiresAt: new Date(Date.now() + 8 * DAY) })), "lifetime-exceeds-cap");
    await rejects(signer.sign(new Uint8Array(33)), "invalid-request");
  });

  it("an edit grant admits put; the signer stops after clear() or expiry", async () => {
    let clock = Date.now();
    const grant = await (await createGrant({ access: "edit", days: 2, now: () => clock })).promise;
    const signer = grant.policySigner();
    await signer.createOwnerRoot(rootInput(grant, { expiresAt: new Date(clock + DAY), capabilities: [{ kind: "kv", resource: RESOURCE, selector: "exact", actions: ["tinycloud.kv/put", "tinycloud.kv/get"] }] }));
    clock += 3 * DAY;
    await rejects(signer.sign(new Uint8Array(32)), "expired");

    const { keys, promise } = await createGrant();
    const cleared = await promise;
    const clearedSigner = cleared.policySigner();
    cleared.clear();
    await rejects(clearedSigner.sign(new Uint8Array(32)), "key-cleared");
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });
});
