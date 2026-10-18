import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, toBase64Url } from "@tinycloud/share-envelope";
import type { SenderShareRecord } from "../../src/history.js";
import {
  canonicalOwnerSharePolicy, computeOwnerShareRegistrationCid, createDelegatedShareKey, createPolicyEnforcementDelegation,
  OWNER_SHARE_REGISTRATION_DOMAIN, type OwnerDelegationReceipt,
} from "../../src/owner-policy.js";
import { attenuationCovers } from "../../src/share-index/verify/attenuation.js";
import { verifyAgentRecordChain, type ChainContext } from "../../src/share-index/verify/chain.js";
import { verifyPolicyEnforcementDelegation } from "../../src/share-index/verify/enforcement-delegation.js";
import { parseSignedUcan } from "../../src/share-index/verify/ucan.js";
import { decideClaim } from "../../src/share-index/precedence.js";
import type { ShareIndexRow } from "../../src/share-index/schema.js";
import { bearerFixture, fakeSiwe, fakeSiweParser, newKey, OWNER_DID, SESSION_ATTENUATION, signUcan, SPACE_ID } from "./helpers.js";

const now = new Date("2026-10-18T12:00:00.000Z");

function context(agentDid: string, overrides: Partial<ChainContext> = {}): ChainContext {
  return { accountOwnerDid: OWNER_DID, agentDid, now, parseSiweCacao: fakeSiweParser, ...overrides };
}

async function verdict(record: SenderShareRecord, ctx: ChainContext) {
  return verifyAgentRecordChain(record, ctx);
}

describe("link UCAN verifier (C4: prf, nbf, exp, attenuation)", () => {
  test("reads prf/nbf/exp from the verified payload; non-JCS WASM-style JSON is accepted", () => {
    const key = newKey();
    const ucan = signUcan(key, { aud: newKey().did, att: { r: { "tinycloud.kv/get": [{}] } }, exp: 2_000_000_000, nbf: 1_000, nnc: "n", prf: ["bafyparent"] });
    const parsed = parseSignedUcan(ucan);
    expect(parsed.issuer).toBe(key.did);
    expect(parsed.proofs).toEqual(["bafyparent"]);
    expect(parsed.notBefore).toBe(1_000);
    expect(parsed.expiresAt).toBe(2_000_000_000);
  });

  test("refuses a forged signature, an unbound JWK, a missing exp and a wrong CID", () => {
    const key = newKey();
    const other = newKey();
    const payload = { aud: other.did, att: { r: { "tinycloud.kv/get": [{}] } }, exp: 2_000_000_000, prf: [] };
    expect(() => parseSignedUcan(signUcan(key, payload, { signWith: other.privateKey }))).toThrow("signature");
    const { exp: _exp, ...noExp } = payload;
    expect(() => parseSignedUcan(signUcan(key, noExp))).toThrow("validity");
    expect(() => parseSignedUcan(signUcan(key, payload), "bafkwrong")).toThrow("CID");
    const swapped = signUcan(key, payload).split(".");
    const other64 = signUcan(other, payload).split(".");
    expect(() => parseSignedUcan(`${other64[0]}.${swapped[1]}.${swapped[2]}`)).toThrow();
  });
});

describe("attenuation containment (prefix rule)", () => {
  test("child == parent or child under parent + '/'; empty-caveat parents are unrestricted", () => {
    const parent = { "space/kv": { "tinycloud.kv/get": [{}] } };
    expect(attenuationCovers(parent, { "space/kv/a/b": { "tinycloud.kv/get": [{ x: 1 }] } })).toBe(true);
    expect(attenuationCovers(parent, { "space/kv": { "tinycloud.kv/get": [{}] } })).toBe(true);
    expect(attenuationCovers(parent, { "space/kvx/a": { "tinycloud.kv/get": [{}] } })).toBe(false);
    expect(attenuationCovers(parent, { "space/kv/a": { "tinycloud.kv/put": [{}] } })).toBe(false);
    expect(attenuationCovers({ "space/kv/dir/": { "tinycloud.kv/get": [{}] } }, { "space/kv/dir/f": { "tinycloud.kv/get": [{}] } })).toBe(true);
    expect(attenuationCovers({ "space/kv": { "tinycloud.kv/get": [{ limit: 1 }] } }, { "space/kv/a": { "tinycloud.kv/get": [{}] } })).toBe(false);
  });
});

describe("bearer chain states (C2, C4)", () => {
  test("proven: full chain to the owner and the leaf issuer is hdr.agentDid", async () => {
    const fixture = bearerFixture({ now });
    expect(await verdict(fixture.record, context(fixture.session.did))).toMatchObject({ ok: true, state: "proven", expired: false, claims: [fixture.linkCid] });
  });

  test("chained: the same chain under another agent's header (a copied proof)", async () => {
    const fixture = bearerFixture({ now });
    expect(await verdict(fixture.record, context(newKey().did))).toMatchObject({ ok: true, state: "chained" });
  });

  test("unproven: the leaf verifies but the owner→session CACAO is gone", async () => {
    const fixture = bearerFixture({ now, withSession: false });
    expect(await verdict(fixture.record, context(fixture.session.did))).toMatchObject({ ok: true, state: "unproven", expired: false });
  });

  test("an expired but valid chain is admitted as expired, not rejected", async () => {
    const leafExpired = bearerFixture({ now, expSeconds: -60 });
    expect(await verdict(leafExpired.record, context(leafExpired.session.did))).toMatchObject({ ok: true, state: "proven", expired: true });
    const siweExpired = bearerFixture({ now, siwe: { expiresAt: new Date(now.getTime() - 1000).toISOString() } });
    expect(await verdict(siweExpired.record, context(siweExpired.session.did))).toMatchObject({ ok: true, state: "proven", expired: true });
  });

  const negatives: [string, () => BearerCase][] = [
    ["prf does not name the CACAO", () => { const f = bearerFixture({ now, link: { prf: ["bafkreiunrelated"] } }); return f; }],
    ["two parents", () => { const f = bearerFixture({ now }); const g = bearerFixture({ now, session: f.session, link: { prf: [f.sessionCid, f.sessionCid] } }); return { ...g, record: { ...g.record, proofs: f.record.proofs! && { ...g.record.proofs, session: f.record.proofs.session } } }; }],
    ["leaf.iss ≠ parent.aud", () => bearerFixture({ now, siwe: { audience: newKey().did } })],
    ["widened attenuation", () => bearerFixture({ now, siwe: { attenuation: { [`${SPACE_ID}/kv/other`]: { "tinycloud.kv/get": [{}] } } } })],
    ["SIWE not signed by the account owner", () => bearerFixture({ now, siwe: { issuer: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" } })],
    ["SIWE signature invalid", () => bearerFixture({ now, siwe: { forged: true } })],
    ["SIWE not yet valid", () => bearerFixture({ now, siwe: { notBefore: new Date(now.getTime() + 3600_000).toISOString() } })],
    ["leaf resource is not the record's", () => { const f = bearerFixture({ now }); return { ...f, record: { ...f.record, resource: { kind: "exact", path: "xyz.tinycloud.share/shares/other/x" } } }; }],
    ["leaf CID is not enforcementDelegationCid", () => { const f = bearerFixture({ now }); return { ...f, record: { ...f.record, enforcementDelegationCid: "bafkreiother" } }; }],
    ["leaf grants more than the record's actions", () => bearerFixture({ now, link: { att: { [`${SPACE_ID}/kv/xyz.tinycloud.share/shares/s/note.txt`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } } } })],
    ["no proof at all", () => { const f = bearerFixture({ now }); const { proofs: _p, ...record } = f.record; return { ...f, record }; }],
  ];
  type BearerCase = ReturnType<typeof bearerFixture>;
  for (const [name, build] of negatives) {
    test(`rejects (proof): ${name}`, async () => {
      const fixture = build();
      expect((await verdict(fixture.record, context(fixture.session.did))).ok).toBe(false);
    });
  }
});

describe("enforcement delegation verifier (C4, new)", () => {
  async function enforcement() {
    const shareKey = await createDelegatedShareKey({ extractable: false });
    const ownerDelegation = { delegationCid: "bafkreiowner" } as OwnerDelegationReceipt;
    return createPolicyEnforcementDelegation({ ownerDelegation, shareKey, enforcerDid: "did:key:z6MkEnforcer", policyCid: "bafkreipolicy", shareId: "share-1", spaceId: SPACE_ID, nodeAudience: "did:key:z6MkNode", path: "shares/share-1/doc.txt", actions: ["tinycloud.kv/get"], contentSourceDigest: "d", expiresAt: "2030-01-01T00:00:00.000Z" });
  }

  test("verifies the share-key signature over the DAG-CBOR bytes and recomputes the CID", async () => {
    const delegation = await enforcement();
    expect(await verifyPolicyEnforcementDelegation(delegation, delegation.cid)).toBe(delegation);
  });

  test("refuses a forged signature, edited facts, another issuer and a wrong CID", async () => {
    const delegation = await enforcement();
    const forged = toBase64Url(ed25519.sign(new Uint8Array([1]), ed25519.utils.randomPrivateKey()));
    await expect(verifyPolicyEnforcementDelegation({ ...delegation, signature: forged })).rejects.toThrow("signature");
    await expect(verifyPolicyEnforcementDelegation({ ...delegation, facts: { ...delegation.facts, path: "shares/other" } })).rejects.toThrow("signed bytes");
    await expect(verifyPolicyEnforcementDelegation({ ...delegation, issuerDid: newKey().did })).rejects.toThrow();
    await expect(verifyPolicyEnforcementDelegation(delegation, "bafkreiother")).rejects.toThrow("CID");
  });
});

describe("Policy/v2 chain: registration key source and expired vs invalid (C4)", () => {
  const nodeKey = ed25519.utils.randomPrivateKey();
  const nodeAudience = "did:key:z6MkNodeAudience";
  const kid = `${nodeAudience}#key-1`;

  async function v2Record(options: { readonly expiresAt?: string; readonly tamperRegistration?: boolean } = {}) {
    const shareKey = await createDelegatedShareKey({ extractable: false });
    const path = "shares/share-1/doc.txt";
    const actions = ["tinycloud.kv/get"] as const;
    const expiresAt = options.expiresAt ?? "2030-01-01T00:00:00.000Z";
    const siwe = fakeSiwe({ issuer: OWNER_DID, audience: shareKey.did, attenuation: { [`${SPACE_ID}/kv/${path}`]: { "tinycloud.kv/get": [{}] } }, expiresAt });
    const target = { origin: "https://node.test", nodeAudience, enforcerDid: "did:key:z6MkEnforcer", spaceId: SPACE_ID };
    const contentSource = { kind: "kv", space: SPACE_ID, path, action: "tinycloud.kv/get" } as const;
    const policy = await canonicalOwnerSharePolicy({ type: "TinyCloudSharePolicy", version: 2, shareId: "share-1", ownerDid: OWNER_DID, shareKeyDid: shareKey.did, recipientMatcher: { kind: "emailDomain", value: "example.com" }, target, resource: { kind: "exact", path }, actions, contentSource, contentSourceDigest: "digest", ownerDelegationCid: siwe.cid, expiresAt });
    const enforcement = await createPolicyEnforcementDelegation({ ownerDelegation: { delegationCid: siwe.cid } as OwnerDelegationReceipt, shareKey, enforcerDid: target.enforcerDid, policyCid: policy.cid, shareId: "share-1", spaceId: SPACE_ID, nodeAudience, path, actions, contentSourceDigest: "digest", expiresAt });
    const core = {
      policyCid: policy.cid, ownerDelegationCid: siwe.cid, enforcementDelegationCid: enforcement.cid, ownerDid: OWNER_DID, shareKeyDid: shareKey.did, enforcerDid: target.enforcerDid,
      shareId: "share-1", recipientMatcher: { kind: "emailDomain", value: "example.com" }, target, resource: { kind: "exact", path }, actions, contentSource, contentSourceDigest: "digest",
      registeredAt: "2026-01-01T00:00:00.000Z", expiresAt,
    };
    const registration = { registrationCid: computeOwnerShareRegistrationCid(core as never), ...core };
    const signed = new TextEncoder().encode(`${OWNER_SHARE_REGISTRATION_DOMAIN}${canonicalize(core)}`);
    const signature = toBase64Url(ed25519.sign(signed, options.tamperRegistration === true ? ed25519.utils.randomPrivateKey() : nodeKey));
    const record: SenderShareRecord = {
      shareId: "share-1", target: { origin: "https://node.test", nodeAudience, spaceId: SPACE_ID }, resource: { kind: "exact", path }, actions: [...actions],
      recipientMatcher: { kind: "emailDomain", value: "example.com" }, targetKind: "emailDomain", registeredAt: now.toISOString(), expiresAt,
      policyCid: policy.cid, ownerDelegationCid: siwe.cid, enforcementDelegationCid: enforcement.cid, registrationCid: registration.registrationCid,
      proofs: { ownerPolicy: toBase64Url(policy.bytes), ownerDelegation: siwe.authorization, enforcementDelegation: enforcement, registration: { registration, proof: { alg: "EdDSA", kid, signature } } as never },
    };
    return record;
  }

  const withKey = (record: SenderShareRecord) => context(newKey().did, { registrationKey: (audience) => audience === nodeAudience ? { kid, publicKey: ed25519.getPublicKey(nodeKey) } : undefined });

  test("with the node key from the share config, every CID including registrationCid is claimed", async () => {
    const record = await v2Record();
    const result = await verdict(record, withKey(record));
    expect(result).toMatchObject({ ok: true, state: "chained", expired: false, claims: [record.policyCid!, record.ownerDelegationCid!, record.enforcementDelegationCid!, record.registrationCid!] });
    // The node-signed registration time anchors registeredAt (±1 day).
    expect(result.ok && result.issued).toEqual({ earliest: Date.parse("2026-01-01T00:00:00.000Z") - 86_400_000, latest: Date.parse("2026-01-01T00:00:00.000Z") + 86_400_000 });
  });

  test("without a registration key, registrationCid is not claimed and the other CIDs still verify", async () => {
    const record = await v2Record();
    const result = await verdict(record, context(newKey().did));
    expect(result).toMatchObject({ ok: true, state: "chained" });
    expect(result.ok && result.claims.includes(record.registrationCid!)).toBe(false);
  });

  test("an expired registration is Expired, an invalid one is rejected", async () => {
    const expired = await v2Record({ expiresAt: "2026-06-01T00:00:00.000Z" });
    expect(await verdict(expired, withKey(expired))).toMatchObject({ ok: true, expired: true });
    const invalid = await v2Record({ tamperRegistration: true });
    expect((await verdict(invalid, withKey(invalid))).ok).toBe(false);
  });

  test("a forged enforcement-delegation signature or a policy not owned by the account is rejected", async () => {
    const record = await v2Record();
    const enforcement = record.proofs!.enforcementDelegation!;
    const forged = { ...record, proofs: { ...record.proofs, enforcementDelegation: { ...enforcement, signature: toBase64Url(new Uint8Array(64)) } } };
    expect((await verdict(forged, withKey(forged))).ok).toBe(false);
    expect((await verdict(record, { ...withKey(record), accountOwnerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" })).ok).toBe(false);
  });
});

describe("precedence: web > proven > chained > unproven, any order (C3)", () => {
  const row = (src: string, ps: ShareIndexRow["ps"] | undefined, cid: string): ShareIndexRow => ({ n: "x", k: "file", ak: "bearer", al: "", a: [], c: "", x: "", rk: "delegation", cid, cc: [cid], src, ...(ps === undefined ? {} : { ps }) });
  const claims: [string, ShareIndexRow["ps"] | undefined][] = [["web", undefined], ["agent:A", "proven"], ["agent:B", "chained"], ["agent:C", "unproven"]];

  test("whatever arrives first, the higher claim holds the CID", () => {
    for (let high = 0; high < claims.length; high++) {
      for (let low = high + 1; low < claims.length; low++) {
        const highRow = row(claims[high]![0], claims[high]![1], "cid1");
        const lowRow = row(claims[low]![0], claims[low]![1], "cid1");
        // Lower admitted first: the higher claim displaces it in the same CAS.
        expect(decideClaim({ low: lowRow }, "high", highRow)).toEqual({ admit: true, displaced: ["low"] });
        // Higher admitted first: the lower claim is refused.
        expect(decideClaim({ high: highRow }, "low", lowRow)).toEqual({ admit: false, heldBy: "high" });
      }
    }
  });

  test("an equal claim never displaces; unproven never displaces anything; web rows coexist", () => {
    for (const ps of ["proven", "chained", "unproven"] as const) {
      expect(decideClaim({ first: row("agent:A", ps, "cid1") }, "second", row("agent:B", ps, "cid1"))).toEqual({ admit: false, heldBy: "first" });
    }
    expect(decideClaim({ web1: row("web", undefined, "cid1") }, "web2", row("web", undefined, "cid1"))).toEqual({ admit: true, displaced: [] });
  });

  test("collisions count across every claimed CID", () => {
    const held = { ...row("agent:A", "chained", "cid1"), cc: ["cid1", "cid2"] };
    expect(decideClaim({ held }, "new", { ...row("agent:B", "proven", "cid9"), cc: ["cid9", "cid2"] })).toEqual({ admit: true, displaced: ["held"] });
  });
});
