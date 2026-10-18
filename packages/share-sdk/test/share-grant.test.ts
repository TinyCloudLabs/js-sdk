import { describe, expect, it } from "bun:test";
import { sha256 } from "@noble/hashes/sha256";
import { verifyCompactUcanAuthorization, type UnifiedContentSource } from "@tinycloud/share-envelope";
import { ADDRESS, APPLICATIONS, DAY, MINUTE, OWNER_DID, SHARE_NETWORK, fakeOwner, rejects, type Tamper } from "./support/fake-owner.js";
import { NODE_DID, fakeNode } from "./support/fake-node.js";
import { createDelegatedShareKey, type DelegatedShareKey } from "../src/index.js";
import type { AddressedOwnerRootInput } from "../src/addressed-publish.js";
import { ShareGrant, openEditShare, perShareNetworkIdFor, revokeShareGrant, type ShareGrantAccess, type ShareGrantRecord } from "../src/share-root-entry.js";

const NODE = "https://node.example";
const SHARE_ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const PATH = `xyz.tinycloud.share/shares/${SHARE_ID}/a.md`;
const RESOURCE = `${APPLICATIONS}/kv/${PATH}`;
const NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:share-${SHARE_ID}`;
const OTHER_NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:share-${OTHER_ID}`;
const VIEW = ["tinycloud.kv/get", "tinycloud.kv/metadata"];
const NETWORK_ACTIONS = ["tinycloud.encryption/network.create", "tinycloud.encryption/network.revoke", "tinycloud.encryption/decrypt"];

interface GrantOptions {
  tamper?: Tamper;
  shareId?: string;
  path?: string;
  access?: ShareGrantAccess;
  days?: number;
  keyFactory?: () => Promise<DelegatedShareKey>;
  fetch?: (input: URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

function request(options: GrantOptions = {}) {
  const owner = fakeOwner(options.tamper, options.now);
  const keys: DelegatedShareKey[] = [];
  return {
    owner,
    keys,
    input: {
      owner,
      spaceId: APPLICATIONS,
      nodeOrigin: NODE,
      shareId: options.shareId ?? SHARE_ID,
      path: options.path ?? PATH,
      access: options.access ?? "view",
      expiresAt: new Date((options.now ?? Date.now)() + (options.days ?? 7) * DAY),
      keyFactory: async () => { const key = await (options.keyFactory ?? (() => createDelegatedShareKey({ extractable: false })))(); keys.push(key); return key; },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  };
}

const createGrant = async (options: GrantOptions = {}) => {
  const { owner, keys, input } = request(options);
  return { owner, keys, grant: await ShareGrant.create(input) };
};

const policyRoot = (grant: ShareGrant, capabilities: AddressedOwnerRootInput["capabilities"]): AddressedOwnerRootInput => ({
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
  nodeAudience: NODE_DID,
  capabilities,
});

describe("perShareNetworkIdFor", () => {
  it("names the share's own network under the lowercase owner, and refuses ids that are not network-safe", async () => {
    expect(perShareNetworkIdFor(OWNER_DID, SHARE_ID)).toBe(NETWORK);
    expect(perShareNetworkIdFor(OWNER_DID, "6f1c7a8e-2b1d-4c3e-9f00-0123456789ab")).toEndWith(":share-6f1c7a8e-2b1d-4c3e-9f00-0123456789ab");
    for (const shareId of ["0123456789ABCDEF0123456789abcdef", "0123456789abcde", "-123456789abcdef0", "0123456789abcdef/x", "0123456789abcdef_x", "0".repeat(37)]) {
      expect(() => perShareNetworkIdFor(OWNER_DID, shareId)).toThrow("shareId must match");
    }
  });
});

describe("ShareGrant.prepare and approve", () => {
  it("prepares a pending row and a key without a prompt; approve asks once for the exact key and the share's network", async () => {
    const { owner, keys, input } = request();
    const pending = await ShareGrant.prepare(input);
    expect(owner.calls).toHaveLength(0);
    expect(pending.row).toEqual({ shareId: SHARE_ID, nw: `share-${SHARE_ID}`, networkId: NETWORK, keyDid: keys[0]!.did, access: "view", path: PATH, state: "pending" });

    const grant = await pending.approve();
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]!.delegateDid).toBe(keys[0]!.did);
    expect(owner.calls[0]!.permissions).toEqual([
      { service: "tinycloud.kv", path: PATH, actions: VIEW },
      { service: "tinycloud.encryption", path: NETWORK, actions: NETWORK_ACTIONS },
    ]);
    expect(grant.row("granted")).toMatchObject({ state: "granted", grantCid: grant.cid });
    await rejects(pending.approve(), "invalid-request");
    expect(owner.calls).toHaveLength(1);

    const record = grant.toRecord();
    expect(record).toMatchObject({ version: 2, shareId: SHARE_ID, networkId: NETWORK, path: PATH, access: "view" });
    expect(JSON.stringify(record)).not.toContain("privateKey");
    expect((await ShareGrant.restore({ record, key: keys[0]! })).cid).toBe(grant.cid);
  });

  it("edit adds kv/put; a TC-1428 artifact version file is a valid path", async () => {
    const edit = await createGrant({ access: "edit" });
    expect(edit.owner.calls[0]!.permissions![0]!.actions).toEqual([...VIEW, "tinycloud.kv/put"]);
    const versioned = await createGrant({ path: "xyz.tinycloud.share/artifacts/abc123/versions/2/report.md" });
    expect(versioned.grant.resource).toBe(`${APPLICATIONS}/kv/xyz.tinycloud.share/artifacts/abc123/versions/2/report.md`);
  });

  it("refuses a bad shareId, path, access or expiry before making a key or asking the owner", async () => {
    for (const [options, code] of [
      [{ shareId: "Share-0123456789abcdef" }, "share-id-not-network-safe"],
      [{ shareId: "short" }, "share-id-not-network-safe"],
      [{ path: `xyz.tinycloud.share/shares/${OTHER_ID}/a.md` }, "invalid-request"],
      [{ path: `xyz.tinycloud.share/shares/${SHARE_ID}/sub/a.md` }, "invalid-request"],
      [{ path: `xyz.tinycloud.share/shares/${SHARE_ID}/` }, "invalid-request"],
      [{ path: "xyz.tinycloud.share/artifacts/abc123/versions/x/report.md" }, "invalid-request"],
      [{ access: "admin" as ShareGrantAccess }, "invalid-request"],
      [{ days: 31 }, "lifetime-exceeds-cap"],
    ] as [GrantOptions, string][]) {
      const { owner, keys, input } = request(options);
      await rejects(ShareGrant.prepare(input), code);
      expect(owner.calls).toHaveLength(0);
      expect(keys).toHaveLength(0);
    }
  });

  it("discard clears the key without a prompt", async () => {
    const { owner, keys, input } = request();
    const pending = await ShareGrant.prepare(input);
    pending.discard();
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
    await rejects(pending.approve(), "invalid-request");
    expect(owner.calls).toHaveLength(0);
  });

  it.each([
    ["decrypt on :share", { att: (att) => { att[SHARE_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch", true],
    ["decrypt on another share's network", { att: (att) => { att[OTHER_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch", true],
    ["kv/put on a view grant", { att: (att) => { att[RESOURCE]!["tinycloud.kv/put"] = [{}]; } }, "ability-mismatch", true],
    ["the whole kv prefix", { att: (att) => { att[`${APPLICATIONS}/kv/xyz.tinycloud.share/shares/`] = { "tinycloud.kv/get": [{}] }; } }, "resource-mismatch", true],
    ["decrypt left out (narrower)", { att: (att) => { delete att[NETWORK]!["tinycloud.encryption/decrypt"]; } }, "ability-mismatch", false],
    ["the network row left out (narrower)", { att: (att) => { delete att[NETWORK]; } }, "resource-mismatch", false],
  ] as [string, Tamper, string, boolean][])("rejects a signed grant with %s and says whether to revoke", async (_case, tamper, code, mustRevoke) => {
    const { keys, input } = request({ tamper });
    const error = await rejects(ShareGrant.create(input), code);
    expect(error.mustRevoke).toBe(mustRevoke);
    await expect(keys[0]!.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  it("restore refuses records that are not per-share v2 or whose network does not match the shareId", async () => {
    const { keys, grant } = await createGrant();
    const record = grant.toRecord();
    await rejects(ShareGrant.restore({ record: { ...record, version: 1 } as unknown as ShareGrantRecord, key: keys[0]! }), "malformed-root");
    await rejects(ShareGrant.restore({ record: { ...record, networkId: OTHER_NETWORK }, key: keys[0]! }), "malformed-root");
    await rejects(ShareGrant.restore({ record: { ...record, networkId: SHARE_NETWORK }, key: keys[0]! }), "malformed-root");
    expect((await ShareGrant.restore({ record: { ...record, networkId: NETWORK.replace(ADDRESS.toLowerCase(), ADDRESS) }, key: keys[0]! })).networkId).toBe(NETWORK);
  });
});

describe("ShareGrant network lifecycle", () => {
  it("ensureNetwork creates the absent network with a key-signed invocation and accepts it only after a fresh lookup", async () => {
    const node = fakeNode();
    const { grant, owner } = await createGrant({ fetch: node.fetch });
    expect(await grant.ensureNetwork()).toBe(NETWORK);
    const create = node.requests.find((entry) => entry.method === "POST")!;
    const body = JSON.stringify({ name: `share-${SHARE_ID}`, ownerDid: `did:pkh:eip155:1:${ADDRESS.toLowerCase()}`, threshold: { n: 1, t: 1 } });
    expect(create.body).toBe(body);
    const { payload } = verifyCompactUcanAuthorization(create.authorization!);
    expect(payload.iss.split("#")[0]).toBe(grant.keyDid);
    expect(payload.aud).toBe(NODE_DID);
    expect(payload.prf).toEqual([grant.cid]);
    expect(payload.att).toEqual({ [NETWORK]: { "tinycloud.encryption/network.create": [{}] } });
    expect(payload.fct[0]).toEqual({ type: "tinycloud.encryption.network-admin/v1", targetNode: NODE_DID, networkId: NETWORK, action: "tinycloud.encryption/network.create", bodyHash: Buffer.from(sha256(new TextEncoder().encode(body))).toString("hex") });
    expect(node.requests.at(-1)).toMatchObject({ method: "GET", path: `/encryption/networks/${NETWORK}` });

    const before = node.requests.length;
    expect(await grant.ensureNetwork()).toBe(NETWORK);
    expect(node.requests.slice(before).every((entry) => entry.method === "GET")).toBe(true);
    expect(owner.calls).toHaveLength(1);
  });

  it("a racing create answered 500 still succeeds when the fresh lookup shows the network active", async () => {
    let raced = false;
    const node = fakeNode({ override: (entry) => entry.method === "POST" && entry.path === "/encryption/networks" && !raced ? (raced = true, undefined) : undefined });
    const base = node.fetch;
    const { grant } = await createGrant({ fetch: async (url, init) => { const response = await base(url, init); return init?.method === "POST" && url.pathname === "/encryption/networks" ? new Response("duplicate key", { status: 500 }) : response; } });
    expect(await grant.ensureNetwork()).toBe(NETWORK);
  });

  it.each([
    ["retired", { state: "revoked" }],
    ["not yet active", { state: "pending" }],
    ["another algorithm", { alg: "x25519-chacha/v9" }],
    ["a threshold other than 1/1", { threshold: { n: 2, t: 1 } }],
    ["another key version", { keyVersion: 2 }],
    ["another owner", { ownerDid: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" }],
    ["another name", { name: `share-${OTHER_ID}` }],
  ] as [string, Record<string, unknown>][])("refuses a network that is %s, and never re-creates it", async (_case, patch) => {
    const node = fakeNode();
    const { grant } = await createGrant({ fetch: node.fetch });
    await grant.ensureNetwork();
    Object.assign(node.networks.get(`urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:share-${SHARE_ID}`)!, patch);
    const before = node.requests.length;
    await rejects(grant.ensureNetwork(), "network-not-active");
    await rejects(grant.assertNetworkActive(), "network-not-active");
    expect(node.requests.slice(before).some((entry) => entry.method === "POST")).toBe(false);
  });

  it("retireNetwork is key-signed and idempotent; a never-created network counts as done", async () => {
    const node = fakeNode();
    const { grant } = await createGrant({ fetch: node.fetch });
    expect(await grant.retireNetwork()).toBe("absent");
    await grant.ensureNetwork();
    expect(await grant.retireNetwork()).toBe("retired");
    const retire = node.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/revoke")).at(-1)!;
    const { payload } = verifyCompactUcanAuthorization(retire.authorization!);
    expect(payload.att).toEqual({ [NETWORK]: { "tinycloud.encryption/network.revoke": [{}] } });
    expect(payload.fct[0]).toMatchObject({ action: "tinycloud.encryption/network.revoke", bodyHash: Buffer.from(sha256(new TextEncoder().encode("{}"))).toString("hex") });
    expect(await grant.retireNetwork()).toBe("retired");
    await rejects(grant.ensureNetwork(), "network-not-active");
  });

  it("retireNetwork reports a Node that refuses", async () => {
    const node = fakeNode({ override: (entry) => entry.method === "POST" && entry.path.endsWith("/revoke") ? new Response("forbidden", { status: 403 }) : undefined });
    const { grant } = await createGrant({ fetch: node.fetch });
    await grant.ensureNetwork();
    await rejects(grant.retireNetwork(), "node-refused");
  });

  it("publishAuthority registers only while the network is active", async () => {
    const node = fakeNode();
    const { grant } = await createGrant({ fetch: node.fetch });
    const registered: unknown[] = [];
    const authority = grant.publishAuthority(async (requestBody) => { registered.push(requestBody); return { policyCid: "bafkpolicy" } as never; });
    await rejects(authority.registerPolicy({} as never), "network-not-active");
    await grant.ensureNetwork();
    await authority.registerPolicy({} as never);
    expect(registered).toHaveLength(1);
    await grant.retireNetwork();
    await rejects(authority.registerPolicy({} as never), "network-not-active");
    expect(registered).toHaveLength(1);
  });
});

describe("ShareGrant scope checks", () => {
  it("policySigner admits only this share's exact key and decrypt on its own network", async () => {
    const { grant } = await createGrant({ days: 10 });
    const signer = grant.policySigner();
    expect(signer.ownerDid).toBe(grant.keyDid);
    expect(signer.rootCid).toBe(grant.cid);
    const kv = { kind: "kv", resource: RESOURCE, selector: "exact", actions: VIEW } as const;
    const decrypt = (resource: string) => ({ kind: "encryption", resource, action: "tinycloud.encryption/decrypt" }) as const;
    const receipt = await signer.createOwnerRoot(policyRoot(grant, [kv, decrypt(NETWORK)]));
    expect(Object.keys(verifyCompactUcanAuthorization(receipt.delegationHeader.Authorization, receipt.cid).payload.att).sort()).toEqual([RESOURCE, NETWORK].sort());
    await signer.createOwnerRoot(policyRoot(grant, [kv, decrypt(NETWORK.replace(ADDRESS.toLowerCase(), ADDRESS))]));
    for (const capabilities of [
      [kv, decrypt(SHARE_NETWORK)],
      [kv, decrypt(OTHER_NETWORK)],
      [{ ...kv, actions: ["tinycloud.kv/put"] }],
      [{ ...kv, selector: "prefix" }],
      [{ ...kv, resource: `${APPLICATIONS}/kv/xyz.tinycloud.share/shares/${OTHER_ID}/a.md` }],
      [{ kind: "encryption", resource: NETWORK, action: "tinycloud.encryption/network.create" }],
    ] as AddressedOwnerRootInput["capabilities"][]) {
      await rejects(signer.createOwnerRoot(policyRoot(grant, capabilities)), "invalid-request");
    }
    await rejects(signer.createOwnerRoot({ ...policyRoot(grant, [kv]), expiresAt: new Date(Date.now() + 11 * DAY) }), "lifetime-exceeds-cap");
    grant.clear();
    await rejects(signer.sign(new Uint8Array(32)), "key-cleared");
  });

  it("assertContentSource accepts only this share's id, exact key and network", async () => {
    const { grant } = await createGrant();
    const source: UnifiedContentSource = { shareId: SHARE_ID, kvResource: RESOURCE, selector: "exact", encryptionNetwork: NETWORK, encryptedSymmetricKeyDigestHex: "e".repeat(64), keyVersion: 1, mode: "mutable" };
    expect(() => grant.assertContentSource(source)).not.toThrow();
    for (const patch of [{ shareId: OTHER_ID }, { kvResource: `${RESOURCE}x` }, { selector: "prefix" as const }, { encryptionNetwork: SHARE_NETWORK }, { encryptionNetwork: OTHER_NETWORK }]) {
      expect(() => grant.assertContentSource({ ...source, ...patch })).toThrow("does not belong");
    }
  });
});

describe("revokeShareGrant", () => {
  it("retires the network before the owner revokes the grant", async () => {
    const node = fakeNode({ override: (entry) => entry.method === "POST" && entry.path === "/revoke" ? new Response(JSON.stringify({ revoked: true, cid: entry.authorization!.slice(6) }), { headers: { "content-type": "application/json" } }) : undefined });
    const { grant } = await createGrant({ fetch: node.fetch });
    await grant.ensureNetwork();
    const signed: string[] = [];
    const result = await revokeShareGrant({ grant, owner: { signOwnerRevocation: async (cid) => { signed.push(cid); return `owner:${cid}`; } }, fetch: node.fetch });
    expect(result).toEqual({ network: "retired", grant: "revoked" });
    expect(signed).toEqual([grant.cid]);
    const order = node.requests.filter((entry) => entry.method === "POST").map((entry) => entry.path);
    expect(order.slice(-2)).toEqual([`/encryption/networks/${NETWORK}/revoke`, "/revoke"]);
  });

  it("says decrypt is cut when the owner step fails", async () => {
    const node = fakeNode({ override: (entry) => entry.method === "POST" && entry.path === "/revoke" ? new Response("nope", { status: 401 }) : undefined });
    const { grant } = await createGrant({ fetch: node.fetch });
    await grant.ensureNetwork();
    const error = await rejects(revokeShareGrant({ grant, owner: { signOwnerRevocation: async (cid) => cid }, fetch: node.fetch }), "grant-revoke-incomplete");
    expect(error.message).toContain("decrypt cut");
    expect(node.networks.get(NETWORK)!.state).toBe("revoked");
  });
});

describe("openEditShare", () => {
  it("asks once for kv/get and decrypt on the share to a key that lives at most one hour", async () => {
    const owner = fakeOwner();
    const record = { spaceId: APPLICATIONS, ownerDid: OWNER_DID, shareId: SHARE_ID, networkId: NETWORK, path: PATH };
    const reader = await openEditShare({ owner, record });
    expect(owner.calls).toHaveLength(1);
    expect(owner.calls[0]!.permissions).toEqual([
      { service: "tinycloud.kv", path: PATH, actions: ["tinycloud.kv/get"] },
      { service: "tinycloud.encryption", path: NETWORK, actions: ["tinycloud.encryption/decrypt"] },
    ]);
    expect(reader.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * MINUTE);
    expect(await reader.signer.sign(new Uint8Array([1]))).toHaveLength(64);
    reader.clear();
    await rejects(reader.signer.sign(new Uint8Array([1])), "expired");

    await rejects(openEditShare({ owner, record, lifetimeMs: 61 * MINUTE }), "lifetime-exceeds-cap");
    await rejects(openEditShare({ owner, record: { ...record, networkId: OTHER_NETWORK } }), "invalid-request");
    expect(owner.calls).toHaveLength(1);
  });
});
