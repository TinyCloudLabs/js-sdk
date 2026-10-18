import { describe, expect, it } from "bun:test";
import { blake3 } from "@noble/hashes/blake3";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import { ed25519 } from "@noble/curves/ed25519";
import { didKeyFromEd25519PublicKey, toBase64Url, verifyCompactUcanAuthorization } from "@tinycloud/share-envelope";
import { createDelegatedShareKey, type CreateOwnerDelegationParams, type DelegatedShareKey, type OwnerDelegationReceipt } from "../src/index.js";
import {
  ShareRoot,
  ShareRootError,
  ensureShareRoot,
  createPolicyOwnerModeProbe,
  readPolicyOwnerAuthorityMode,
  type ShareRootOwnerAuthority,
} from "../src/share-root-entry.js";

const DAY = 86_400_000;
const ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const OWNER_DID = `did:pkh:eip155:1:${ADDRESS}`;
const APPLICATIONS = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const DEFAULT_SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:default`;
const KV_PREFIX = `${APPLICATIONS}/kv/xyz.tinycloud.share/shares/`;
const SHARE_NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:share`;
const DEFAULT_NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS.toLowerCase()}:default`;
const NODE = "https://node.example";
const LINK_PATH = "xyz.tinycloud.share/shares/abc/a.md";

/** Minimal DAG-CBOR encoder for synthetic CACAO fixtures (text, ints, bytes, arrays, maps). */
function cbor(value: unknown): number[] {
  const head = (major: number, length: number): number[] =>
    length < 24 ? [(major << 5) | length] : length < 0x100 ? [(major << 5) | 24, length] : [(major << 5) | 25, length >> 8, length & 0xff];
  if (typeof value === "number") return head(0, value);
  if (typeof value === "string") { const bytes = new TextEncoder().encode(value); return [...head(3, bytes.length), ...bytes]; }
  if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
  if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
  const entries = Object.entries(value as Record<string, unknown>);
  return [...head(5, entries.length), ...entries.flatMap(([key, entry]) => [...cbor(key), ...cbor(entry)])];
}

interface Tamper {
  att?: (att: Record<string, Record<string, unknown[]>>) => void;
  audience?: string;
  issuer?: string;
  expiresAt?: Date;
  issuedAt?: Date;
  extraResources?: string[];
  prf?: unknown[];
  cid?: string;
}

/** An owner that signs (synthetically) whatever it is asked, optionally tampered, and counts approvals. */
function fakeOwner(tamper: Tamper = {}, now = () => Date.now()): ShareRootOwnerAuthority & { calls: CreateOwnerDelegationParams[] } {
  const calls: CreateOwnerDelegationParams[] = [];
  return {
    ownerDid: OWNER_DID,
    calls,
    async createOwnerDelegation(params) {
      calls.push(params);
      const att: Record<string, Record<string, unknown[]>> = {};
      for (const permission of params.permissions ?? []) {
        const resource = permission.service === "tinycloud.kv" ? `${params.spaceId}/kv/${permission.path}` : permission.path;
        att[resource] = Object.fromEntries(permission.actions.map((action) => [action, [{}]]));
      }
      tamper.att?.(att);
      const recap = `urn:recap:${toBase64Url(new TextEncoder().encode(JSON.stringify({ att, prf: tamper.prf ?? [] })))}`;
      const payload = {
        domain: "share.example",
        iss: tamper.issuer ?? OWNER_DID,
        aud: tamper.audience ?? params.delegateDid,
        version: 1,
        nonce: "n0nce",
        iat: (tamper.issuedAt ?? new Date(now())).toISOString(),
        exp: (tamper.expiresAt ?? params.expiresAt).toISOString(),
        resources: [...(tamper.extraResources ?? []), recap],
      };
      const bytes = Uint8Array.from(cbor({ h: { t: "eip4361" }, p: payload, s: { t: "eip191", s: new Uint8Array(65) } }));
      const cid = tamper.cid ?? CID.createV1(0x55, createDigest(0x1e, blake3(bytes))).toString();
      return {
        delegationCid: cid,
        signedDagCbor: bytes,
        delegation: { delegateDID: params.delegateDid, spaceId: params.spaceId, path: "", actions: [], expiry: params.expiresAt },
      } satisfies OwnerDelegationReceipt;
    },
  };
}

/** A Node `/info` answering `body` (JSON) and recording each probe. */
function infoFetch(body: unknown, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** `GET /info` as NODE-B2 §9 advertises it: the marker plus one mode in `features`. */
const info = (...extra: unknown[]) => ({ protocol: 1, version: "1.22.0", features: ["kv", "delegation", ...extra] });
const ENFORCING = ["policy-owner-authority-v1", "policy-owner-authority-enforce"];
const RECORDING = ["policy-owner-authority-v1", "policy-owner-authority-record"];

async function linkDid(): Promise<string> {
  return didKeyFromEd25519PublicKey(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
}

async function rejects(promise: Promise<unknown>, code: string): Promise<ShareRootError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ShareRootError);
  expect((error as ShareRootError).code).toBe(code as ShareRootError["code"]);
  return error as ShareRootError;
}

async function createRoot(options: { tamper?: Tamper; key?: DelegatedShareKey; days?: number; kind?: "share" | "agent"; spaceId?: string; flag?: boolean; fetch?: typeof fetch } = {}) {
  const owner = fakeOwner(options.tamper);
  const key = options.key ?? await createDelegatedShareKey({ extractable: false });
  const promise = ShareRoot.create({
    owner,
    key,
    spaceId: options.spaceId ?? (options.kind === "agent" ? DEFAULT_SPACE : APPLICATIONS),
    expiresAt: new Date(Date.now() + (options.days ?? 37) * DAY),
    options: { kind: options.kind ?? "share", nodeOrigin: NODE, ...(options.flag === undefined ? {} : { shareRootPolicyRoots: options.flag }), ...(options.fetch === undefined ? {} : { policyOwnerModeProbe: createPolicyOwnerModeProbe({ fetch: options.fetch }) }) },
  });
  return { owner, key, promise };
}

describe("ShareRoot.create", () => {
  it("requests exactly the read-only root through one owner approval and keeps the signed CACAO", async () => {
    const { owner, key, promise } = await createRoot();
    const root = await promise;
    expect(owner.calls).toHaveLength(1);
    const call = owner.calls[0]!;
    expect(call.delegateDid).toBe(key.did);
    expect(call.spaceId).toBe(APPLICATIONS);
    expect(call.permissions).toEqual([
      { service: "tinycloud.kv", path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] },
      { service: "tinycloud.encryption", path: SHARE_NETWORK, actions: ["tinycloud.encryption/decrypt"] },
    ]);
    expect(root.keyDid).toBe(key.did);
    expect(root.expiresAt.getTime()).toBe(call.expiresAt.getTime());

    const restored = await ShareRoot.restore({ record: root.toRecord(), key });
    expect(restored.cid).toBe(root.cid);
    expect(JSON.stringify(root.toRecord())).not.toContain("privateKey");
  });

  it("agent roots are kv-only in the default space", async () => {
    const { owner, promise } = await createRoot({ kind: "agent", days: 30 });
    await promise;
    expect(owner.calls[0]!.permissions).toEqual([{ service: "tinycloud.kv", path: "xyz.tinycloud.share/shares/", actions: ["tinycloud.kv/get", "tinycloud.kv/metadata"] }]);
  });

  it("refuses over-cap lifetimes, wrong spaces and extractable keys before asking the owner", async () => {
    for (const options of [
      { days: 38 },
      { kind: "agent" as const, days: 31 },
      { spaceId: DEFAULT_SPACE },
      { kind: "agent" as const, spaceId: APPLICATIONS, days: 30 },
      { spaceId: `tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications` },
    ]) {
      const { owner, promise } = await createRoot(options);
      await rejects(promise, options.days !== undefined && options.spaceId === undefined ? "lifetime-exceeds-cap" : "invalid-request");
      expect(owner.calls).toHaveLength(0);
    }
    const { owner, promise } = await createRoot({ key: await createDelegatedShareKey({ extractable: true }) });
    await rejects(promise, "invalid-key");
    expect(owner.calls).toHaveLength(0);
  });

  it.each([
    ["kv/put added to the prefix", { att: (att) => { att[KV_PREFIX]!["tinycloud.kv/put"] = [{}]; } }, "ability-mismatch"],
    ["kv/list added to the prefix", { att: (att) => { att[KV_PREFIX]!["tinycloud.kv/list"] = [{}]; } }, "ability-mismatch"],
    ["network.create added to :share", { att: (att) => { att[SHARE_NETWORK]!["tinycloud.encryption/network.create"] = [{}]; } }, "ability-mismatch"],
    ["a caveat on kv/get", { att: (att) => { att[KV_PREFIX]!["tinycloud.kv/get"] = [{ prefix: "x" }]; } }, "ability-mismatch"],
    ["kv/metadata dropped", { att: (att) => { delete att[KV_PREFIX]!["tinycloud.kv/metadata"]; } }, "ability-mismatch"],
    ["capabilities/read on the space", { att: (att) => { att[`${APPLICATIONS}/capabilities/`] = { "tinycloud.capabilities/read": [{}] }; } }, "resource-mismatch"],
    ["decrypt on :default", { att: (att) => { att[DEFAULT_NETWORK] = { "tinycloud.encryption/decrypt": [{}] }; } }, "resource-mismatch"],
    ["a kv path outside the prefix", { att: (att) => { att[`${APPLICATIONS}/kv/`] = { "tinycloud.kv/get": [{}] }; } }, "resource-mismatch"],
    ["a non-ReCap SIWE resource", { extraResources: ["https://example.com/extra"] }, "resource-mismatch"],
    ["a parent capability", { prf: ["bafy-parent"] }, "resource-mismatch"],
    ["another audience", { audience: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" }, "audience-mismatch"],
    ["another owner", { issuer: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001" }, "issuer-mismatch"],
    ["a 40-day signed lifetime", { expiresAt: new Date(Date.now() + 40 * DAY) }, "lifetime-exceeds-cap"],
    ["a back-dated issue time stretching the lifetime", { issuedAt: new Date(Date.now() - 2 * DAY) }, "lifetime-exceeds-cap"],
    ["a silently clamped expiry", { expiresAt: new Date(Date.now() + 30 * DAY) }, "expiry-mismatch"],
    ["bytes that do not hash to the CID", { cid: "bafkr4ibsw5yjl7ffzhpn53mf6h53yc7mozvvpifsg2jw7r4pzivjnrlrpa" }, "malformed-root"],
  ] as [string, Tamper, string][])("rejects a signed root with %s and clears the key", async (_case, tamper, code) => {
    const { owner, key, promise } = await createRoot({ tamper });
    const error = await rejects(promise, code);
    expect(owner.calls).toHaveLength(1);
    expect(error.rootCid).toBeString();
    await expect(key.sign(new Uint8Array([1]))).rejects.toThrow("cleared");
  });

  it("rejects an expired stored root", async () => {
    const { key, promise } = await createRoot({ days: 1 });
    const record = (await promise).toRecord();
    await rejects(ShareRoot.restore({ record, key, options: { now: () => Date.now() + 2 * DAY } }), "expired");
    await rejects(ShareRoot.restore({ record, key: await createDelegatedShareKey({ extractable: false }) }), "audience-mismatch");
    await rejects(ShareRoot.restore({ record: { ...record, kind: "agent", spaceId: DEFAULT_SPACE }, key }), "resource-mismatch");
  });
});

describe("ShareRoot.signBearerLink", () => {
  it("signs kv/get on one exact key with the root as its only proof", async () => {
    const { key, promise } = await createRoot();
    const root = await promise;
    const did = await linkDid();
    const link = await root.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(Date.now() + 7 * DAY) });
    const verified = verifyCompactUcanAuthorization(link.delegation.authorization, link.delegation.cid);
    expect(verified.payload.iss.split("#")[0]).toBe(key.did);
    expect(verified.payload.aud).toBe(did);
    expect(verified.payload.prf).toEqual([root.cid]);
    expect(verified.payload.att).toEqual({ [`${APPLICATIONS}/kv/${LINK_PATH}`]: { "tinycloud.kv/get": [{}] } });
    expect(verified.payload.exp).toBeLessThanOrEqual(Math.floor(root.expiresAt.getTime() / 1000));
  });

  it("refuses links outside the prefix, beyond the root, beyond 30 days, or after expiry", async () => {
    const { promise } = await createRoot({ days: 20 });
    const root = await promise;
    const did = await linkDid();
    const week = new Date(Date.now() + 7 * DAY);
    for (const path of ["xyz.tinycloud.share/shares/", "xyz.tinycloud.share/shares/a/", "xyz.tinycloud.other/a.md", "xyz.tinycloud.share/shares/../x", "xyz.tinycloud.share/shares/*"]) {
      await rejects(root.signBearerLink({ linkDid: did, path, expiresAt: week }), "link-out-of-scope");
    }
    await rejects(root.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(Date.now() + 21 * DAY) }), "lifetime-exceeds-cap");
    await rejects(root.signBearerLink({ linkDid: root.keyDid, path: LINK_PATH, expiresAt: week }), "invalid-request");

    const long = await (await createRoot()).promise;
    await rejects(long.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(Date.now() + 31 * DAY) }), "lifetime-exceeds-cap");

    let clock = Date.now();
    const { key: clockKey, promise: clockPromise } = await createRoot({ days: 2 });
    const clocked = await ShareRoot.restore({ record: (await clockPromise).toRecord(), key: clockKey, options: { now: () => clock } });
    clock += 3 * DAY;
    await rejects(clocked.signBearerLink({ linkDid: did, path: LINK_PATH, expiresAt: new Date(clock + DAY) }), "expired");
  });
});

describe("ShareRoot.policyRootSigner", () => {
  it("refuses with the shareRootPolicyRoots flag off, without probing the node", async () => {
    const probes: string[] = [];
    const root = await (await createRoot({ fetch: infoFetch(info(...ENFORCING), probes) })).promise;
    await rejects(root.policyRootSigner({ expiresAt: new Date(Date.now() + DAY) }), "policy-roots-disabled");
    expect(probes).toEqual([]);
  });

  it.each([
    ["mode record", infoFetch(info(...RECORDING))],
    ["no marker (every Node up to 1.21.0)", infoFetch(info())],
    ["the enforce mode without the marker", infoFetch(info("policy-owner-authority-enforce"))],
    ["both modes at once", infoFetch(info(...ENFORCING, "policy-owner-authority-record"))],
    ["a differently cased mode", infoFetch(info("policy-owner-authority-v1", "policy-owner-authority-ENFORCE"))],
    ["a malformed features value", infoFetch({ features: "policy-owner-authority-v1 policy-owner-authority-enforce" })],
    ["an unreachable Node", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch],
    ["a failing Node", (async () => new Response(JSON.stringify(info(...ENFORCING)), { status: 503 })) as unknown as typeof fetch],
    ["a non-JSON answer", (async () => new Response("<html>")) as unknown as typeof fetch],
  ] as [string, typeof fetch][])("refuses with the flag on and %s", async (_case, fetchFn) => {
    const root = await (await createRoot({ flag: true, fetch: fetchFn })).promise;
    await rejects(root.policyRootSigner({ expiresAt: new Date(Date.now() + DAY) }), "policy-roots-not-enforced-by-node");
  });

  it("opens only with the flag on and mode enforce, and caps policy roots at the root's expiry", async () => {
    const probes: string[] = [];
    const root = await (await createRoot({ days: 10, flag: true, fetch: infoFetch(info(...ENFORCING), probes) })).promise;
    const signer = await root.policyRootSigner({ expiresAt: new Date(Date.now() + 7 * DAY) });
    expect(probes).toEqual([`${NODE}/info`]);
    expect(signer.ownerDid).toBe(root.keyDid);
    expect(signer.notAfter.getTime()).toBe(root.expiresAt.getTime());
    await rejects(root.policyRootSigner({ expiresAt: new Date(Date.now() + 11 * DAY) }), "lifetime-exceeds-cap");

    const agent = await (await createRoot({ kind: "agent", days: 30, flag: true, fetch: infoFetch(info(...ENFORCING)) })).promise;
    await rejects(agent.policyRootSigner({ expiresAt: new Date(Date.now() + DAY) }), "policy-roots-disabled");
  });

  it("caches the answer per Node for at most 5 minutes, takes sign-in features without a fetch, and turns off when a Node drops enforce", async () => {
    let features = ENFORCING;
    let clock = 1_000_000;
    const probes: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => { probes.push(String(input)); return new Response(JSON.stringify(info(...features))); }) as typeof fetch;
    const probe = createPolicyOwnerModeProbe({ fetch: fetchFn, ttlMs: 60 * 60_000, now: () => clock });
    expect(await probe.isEnforced(NODE)).toBe(true);
    features = RECORDING;
    clock += 4 * 60_000;
    expect(await probe.isEnforced(`${NODE}/some/path`)).toBe(true);
    expect(probes).toHaveLength(1);
    clock += 61_000; // past the 5-minute ceiling even though 60 minutes were asked for
    expect(await probe.isEnforced(NODE)).toBe(false);
    expect(probes).toHaveLength(2);
    expect(await probe.isEnforced("https://other-node.example")).toBe(false);
    expect(probes).toHaveLength(3);

    const owner = fakeOwner();
    const root = await ShareRoot.create({ owner, key: await createDelegatedShareKey({ extractable: false }), spaceId: APPLICATIONS, expiresAt: new Date(Date.now() + 10 * DAY), options: { nodeOrigin: NODE, shareRootPolicyRoots: true, policyOwnerModeProbe: probe } });
    await rejects(root.policyRootSigner({ expiresAt: new Date(Date.now() + DAY) }), "policy-roots-not-enforced-by-node");
    // A sign-in reads `/info` anyway; its features refresh the answer at once.
    probe.observe(NODE, ["kv", ...ENFORCING]);
    await expect(root.policyRootSigner({ expiresAt: new Date(Date.now() + DAY) })).resolves.toMatchObject({ rootCid: root.cid });
    probe.observe(NODE, ["kv", ...RECORDING]);
    await rejects(root.policyRootSigner({ expiresAt: new Date(Date.now() + DAY) }), "policy-roots-not-enforced-by-node");
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
  it("keeps a covering root, and re-roots once with a new key and the full lifetime when it does not cover", async () => {
    const owner = fakeOwner();
    const keys: DelegatedShareKey[] = [];
    const newKey = async () => { const key = await createDelegatedShareKey({ extractable: false }); keys.push(key); return key; };
    const first = await ensureShareRoot({ linkExpiresAt: new Date(Date.now() + 7 * DAY), owner, spaceId: APPLICATIONS, newKey });
    expect(first.rerooted).toBe(true);
    expect(owner.calls).toHaveLength(1);
    expect(Math.round((first.root.expiresAt.getTime() - Date.now()) / DAY)).toBe(37);

    const kept = await ensureShareRoot({ current: first.root, linkExpiresAt: new Date(Date.now() + 30 * DAY), owner, spaceId: APPLICATIONS, newKey });
    expect(kept).toEqual({ root: first.root, rerooted: false });
    expect(owner.calls).toHaveLength(1);

    const later = () => Date.now() + 10 * DAY;
    const rerooted = await ensureShareRoot({ current: first.root, linkExpiresAt: new Date(later() + 30 * DAY), owner: fakeOwner({}, later), spaceId: APPLICATIONS, newKey, options: { now: later } });
    expect(rerooted.rerooted).toBe(true);
    expect(rerooted.root.keyDid).not.toBe(first.root.keyDid);

    await rejects(ensureShareRoot({ current: first.root, linkExpiresAt: new Date(later() + 30 * DAY), owner, spaceId: APPLICATIONS, newKey: async () => keys[0]!, options: { now: later } }), "reroot-same-key");
    await rejects(ensureShareRoot({ linkExpiresAt: new Date(Date.now() + 31 * DAY), owner, spaceId: APPLICATIONS, newKey }), "lifetime-exceeds-cap");
  });
});
