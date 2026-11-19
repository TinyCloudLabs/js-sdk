import { describe, expect, test } from "bun:test";
import { canonicalize, seal, toBase64Url } from "@tinycloud/share-envelope";
import { verifyAgentRecordChain, type SenderShareRecord, type StoredShareRecord } from "@tinycloud/share-sdk/share-index";
import { parseSignedSiweCacao } from "./cacao";
import fixture from "./fixtures/share-index-chain.json";

/**
 * TC-1432 slice 2: the share-sdk chain verifier on real signed material from
 * a local tinycloud-node (throwaway owner), with the real SIWE CACAO parser
 * the web and CLI inject. Times are pinned to when the material was minted.
 */
const minted = new Date(fixture.generatedAt);

function bearerRecord(overrides: Partial<SenderShareRecord> = {}): SenderShareRecord {
  return {
    shareId: fixture.link.cid,
    target: { origin: "https://node.test", nodeAudience: "did:key:z6MkNode", spaceId: fixture.spaceId },
    resource: { kind: "exact", path: fixture.link.path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "bearer" },
    targetKind: "bearer",
    registeredAt: minted.toISOString(),
    expiresAt: new Date(minted.getTime() + 3_600_000).toISOString(),
    enforcementDelegationCid: fixture.link.cid,
    proofs: { link: fixture.link.authorization, session: fixture.session.authorization },
    ...overrides,
  };
}

const context = (agentDid: string, now = minted, accountOwnerDid = fixture.ownerDid) => ({ accountOwnerDid, agentDid, now, parseSiweCacao: parseSignedSiweCacao });

describe("share index chain verifier on real delegations", () => {
  test("the agent session's own link verifies as proven; the account owner matches in either address spelling", async () => {
    const result = await verifyAgentRecordChain(bearerRecord(), context(fixture.agentDid));
    expect(result).toMatchObject({ ok: true, state: "proven", expired: false, claims: [fixture.link.cid] });
    // WASM link delegations carry no `nbf`: the session's signed Issued At and the link's expiry bound registeredAt.
    expect(result.ok && result.issued.earliest! < minted.getTime() && minted.getTime() < result.issued.latest!).toBe(true);
    expect(await verifyAgentRecordChain(bearerRecord(), context(fixture.agentDid, minted, fixture.ownerDid.toLowerCase()))).toMatchObject({ ok: true, state: "proven" });
  });

  test("the same chain filed by another agent is only chained", async () => {
    expect(await verifyAgentRecordChain(bearerRecord(), context("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"))).toMatchObject({ ok: true, state: "chained" });
  });

  test("without the CACAO it is unproven; after expiry it is expired, not rejected", async () => {
    expect(await verifyAgentRecordChain(bearerRecord({ proofs: { link: fixture.link.authorization } }), context(fixture.agentDid))).toMatchObject({ ok: true, state: "unproven" });
    expect(await verifyAgentRecordChain(bearerRecord(), context(fixture.agentDid, new Date(minted.getTime() + 7 * 86_400_000)))).toMatchObject({ ok: true, state: "proven", expired: true });
  });

  test("another account owner, a tampered CACAO or a link for another resource is rejected", async () => {
    expect((await verifyAgentRecordChain(bearerRecord(), context(fixture.agentDid, minted, "did:pkh:eip155:1:0x1111111111111111111111111111111111111111"))).ok).toBe(false);
    const session = fixture.session.authorization;
    const tampered = `${session.slice(0, 200)}${session[200] === "A" ? "B" : "A"}${session.slice(201)}`;
    expect((await verifyAgentRecordChain(bearerRecord({ proofs: { link: fixture.link.authorization, session: tampered } }), context(fixture.agentDid))).ok).toBe(false);
    expect((await verifyAgentRecordChain(bearerRecord({ resource: { kind: "exact", path: "xyz.tinycloud.share/shares/other/x" } }), context(fixture.agentDid))).ok).toBe(false);
  });
});

/** The record's delivery material as stored: the real envelope, sealed the way `publishAddressedShare` seals it. */
async function sealed(envelope: unknown): Promise<NonNullable<StoredShareRecord["deliveryMaterial"]>> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const blob = await seal(new TextEncoder().encode(canonicalize(envelope)), key);
  return { shareCid: blob.cid, sealedEnvelope: toBase64Url(blob.blob), envelopeKey: toBase64Url(key) };
}

async function v3Record(overrides: Partial<StoredShareRecord> = {}): Promise<StoredShareRecord> {
  const v3 = fixture.v3;
  return {
    shareId: v3.shareId,
    target: v3.target,
    resource: { kind: "exact", path: v3.resource.path },
    actions: ["tinycloud.kv/get"],
    recipientMatcher: { kind: "recipientDid", value: v3.recipientMatcher.value },
    targetKind: "recipientDid",
    registeredAt: v3.registeredAt,
    expiresAt: v3.expiresAt,
    policyCid: v3.policyCid,
    ownerDelegationCid: v3.policyRootCid,
    enforcementDelegationCid: v3.enforcementRootCid,
    ownerDid: fixture.agentDid,
    // Stored form: the verifier opens the envelope from the sealed material.
    deliveryMaterial: await sealed(v3.envelope),
    proofs: { session: fixture.session.authorization },
    ...overrides,
  };
}

describe("share index chain verifier on a real Policy/v3 share", () => {
  test("the session-owned policy verifies as proven, claiming the policy and both roots", async () => {
    const result = await verifyAgentRecordChain(await v3Record(), context(fixture.agentDid));
    expect(result).toMatchObject({ ok: true, state: "proven", expired: false, claims: [fixture.v3.policyCid, fixture.v3.policyRootCid, fixture.v3.enforcementRootCid] });
    // The node-signed enforcer binding's issuedAt anchors registeredAt (±1 day).
    const issuedAt = Date.parse(fixture.v3.envelope.attestedEnforcerBinding.issuedAt);
    expect(result.ok && result.issued).toEqual({ earliest: issuedAt - 86_400_000, latest: issuedAt + 86_400_000 });
  });

  test("chained under another agent, unproven without the CACAO, expired after the binding window", async () => {
    const { ownerDid: _ownerDid, ...withoutOwner } = await v3Record();
    expect(await verifyAgentRecordChain(withoutOwner, context("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"))).toMatchObject({ ok: true, state: "chained" });
    expect(await verifyAgentRecordChain(await v3Record({ proofs: {} }), context(fixture.agentDid))).toMatchObject({ ok: true, state: "unproven" });
    expect(await verifyAgentRecordChain(await v3Record(), context(fixture.agentDid, new Date(minted.getTime() + 2 * 3_600_000)))).toMatchObject({ ok: true, state: "proven", expired: true });
  });

  test("an envelope bound to other CIDs, a tampered policy or another owner is rejected", async () => {
    expect((await verifyAgentRecordChain(await v3Record({ enforcementDelegationCid: fixture.v3.policyRootCid }), context(fixture.agentDid))).ok).toBe(false);
    const envelope = structuredClone(fixture.v3.envelope);
    envelope.policy.createdAt = "2020-01-01T00:00:00Z";
    expect((await verifyAgentRecordChain(await v3Record({ deliveryMaterial: await sealed(envelope) }), context(fixture.agentDid))).ok).toBe(false);
    expect((await verifyAgentRecordChain(await v3Record(), context(fixture.agentDid, minted, "did:pkh:eip155:1:0x1111111111111111111111111111111111111111"))).ok).toBe(false);
  });
});
