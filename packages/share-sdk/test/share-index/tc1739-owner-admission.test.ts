import { describe, expect, setSystemTime, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalize, fromBase64Url, seal, shareEnvelopeV3Schema, signEnvelopeV3, toBase64Url } from "@tinycloud/share-envelope";
import { buildFullLink, openLinkRecord, parseLink, prepareLinkRecord, signerFromSeed } from "@tinycloud/share-envelope/links";
import { historyRecordForPublishedShare, publishAddressedShare } from "../../src/index.js";
import type { SenderShareRecord } from "../../src/history.js";
import { compactShareRecord, expandShareRecord } from "../../src/share-index/delivery.js";
import { checkAgentRecordSchema } from "../../src/share-index/schema.js";
import { AgentShareRecordStore } from "../../src/share-index/record-store.js";
import { agentIdFromDid, agentRecordKey, SHARE_RECORDS_VAULT_PREFIX } from "../../src/share-index/ids.js";
import { sealAgentRecord } from "../../src/share-index/agent-record.js";
import { MemoryShareIndexOutbox, SenderShareIndex } from "../../src/share-index/sender-share-index.js";
import { CONTENT_SPACE_ID, fakeSiwe, fakeSiweParser, MemoryBackend, NETWORK_ID, OWNER_DID, SHARE_ORIGIN, SPACE_ID, bearerFixture } from "./helpers.js";
import { foreignSeed, nodeDid, ownerDid, ownerSeed, signedBinding, signedRoot } from "../support/signed-share.js";

async function published(artifact = false) {
  const shareId = crypto.randomUUID().replaceAll("-", "");
  const path = artifact ? "artifacts/art_history/versions/7/note.txt" : `shares/${shareId}/note.txt`;
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000);
  const result = await publishAddressedShare({
    shareId, shareOrigin: SHARE_ORIGIN, nodeOrigin: "https://node.test", nodeAudience: nodeDid, enforcerDid: nodeDid,
    spaceId: CONTENT_SPACE_ID, target: { kind: "recipientDid", did: nodeDid },
    resource: { kind: "exact", path }, actions: ["read"], policyActions: ["tinycloud.kv/get", "tinycloud.kv/metadata"],
    contentSource: { shareId, kvResource: `${CONTENT_SPACE_ID}/kv/${path}`, selector: "exact", encryptionNetwork: NETWORK_ID, encryptedSymmetricKeyDigestHex: "1".repeat(64), keyVersion: 1, mode: "immutable", initialCiphertextDigestHex: "2".repeat(64) },
    ...(artifact ? { artifactPin: { v: 1 as const, artifactId: "art_history", version: 7, manifestSha256: "3".repeat(64), files: [{ path: "note.txt", sha256: "2".repeat(64), bytes: 8 }] } } : {}),
    filename: "note.txt", mediaType: "text/plain", byteLength: 8, expiresAt,
    authority: { ownerDid, createOwnerRoot: async input => signedRoot(input), sign: async bytes => ed25519.sign(bytes, ownerSeed), registerPolicy: async input => ({ policyCid: input.policyCid, policyRootCid: input.policyRoot.cid, enforcementRootCid: input.enforcementRoot.cid, attestedEnforcerBinding: signedBinding(expiresAt) }) },
  });
  const session = fakeSiwe({ issuer: OWNER_DID, audience: ownerDid, issuedAt: new Date().toISOString(), expiresAt: new Date(expiresAt.getTime() + 3_600_000).toISOString(), attenuation: { [`${CONTENT_SPACE_ID}/kv`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/metadata": [{}] }, [NETWORK_ID]: { "tinycloud.encryption/decrypt": [{}] } } });
  return { ...historyRecordForPublishedShare(result), proofs: { session: session.authorization } };
}

function index(backend: MemoryBackend, now = new Date(), shareOrigins = [SHARE_ORIGIN]) {
  return new SenderShareIndex({ backend, ownerDid: OWNER_DID, writer: "web", outbox: new MemoryShareIndexOutbox(), shareOrigins, parseSiweCacao: fakeSiweParser, now: () => now });
}

async function writePayload(backend: MemoryBackend, shareId: string, agentDid: string, value: unknown) {
  const key = agentRecordKey(agentIdFromDid(agentDid), shareId);
  const stored = await sealAgentRecord({ plaintext: new TextEncoder().encode(JSON.stringify(value)), spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}`, agentDid, ownerNetworkId: NETWORK_ID, ownerWrap: backend.network });
  await backend.writeRaw(key, Object.fromEntries(Object.entries(stored)), { ifNoneMatch: "*" });
  return key;
}

async function originalMetadata(link: string) {
  const parsed = parseLink(link, { trustedOrigins: [SHARE_ORIGIN] });
  if (parsed.form !== "full") throw new Error("expected publisher full link");
  const checked = await openLinkRecord(parsed.record, parsed.key);
  if (checked.signature === undefined) throw new Error("expected publisher signature");
  return { origin: parsed.origin, header: checked.header, signature: checked.signature };
}

describe("TC-1739 canonical artifact and original full-link admission", () => {
  test("admits an exact native artifact UCAN without treating artifact or storage IDs as share identity", async () => {
    const path = "artifacts/art_native/versions/3/note.txt";
    const fixture = bearerFixture({ contentSpace: CONTENT_SPACE_ID, link: { att: { [`${CONTENT_SPACE_ID}/kv/${path}`]: { "tinycloud.kv/get": [{}] } } }, record: { resource: { kind: "exact", path } } });
    const backend = new MemoryBackend();
    await new AgentShareRecordStore({ backend, agentDid: fixture.session.did }).put(fixture.record);
    expect(await index(backend).reconcile()).toMatchObject({ admitted: 1, rejected: {} });
  });

  test("preserves the actual publisher full link with one sealed body and admits its original signed artifact pin", async () => {
    const full = await published(true);
    const stored = await compactShareRecord(full);
    expect(stored.link).toBeUndefined();
    expect(stored.deliveryMaterial).toHaveProperty("fullLink", await originalMetadata(full.link!));
    expect((await expandShareRecord(stored)).link).toBe(full.link);
    const backend = new MemoryBackend();
    await new AgentShareRecordStore({ backend, agentDid: ownerDid }).put(full);
    expect(await index(backend).reconcile()).toMatchObject({ admitted: 1, rejected: {} });
  });

  for (const source of [
    { name: "addressed artifact", artifact: true, targetKind: "bearer" },
    { name: "non-artifact addressed", artifact: false, targetKind: undefined },
  ] as const) {
    test(`native artifact admission keeps ${source.name} material separate`, async () => {
      const path = "artifacts/art_native/versions/3/note.txt";
      const native = bearerFixture({ contentSpace: CONTENT_SPACE_ID, link: { att: { [`${CONTENT_SPACE_ID}/kv/${path}`]: { "tinycloud.kv/get": [{}] } } }, record: { resource: { kind: "exact", path } } });
      const full = await published(source.artifact);
      const stored = await compactShareRecord(full);
      const { link: _nativeLink, ...record } = native.record;
      const backend = new MemoryBackend();
      const key = await writePayload(backend, record.shareId, native.session.did, {
        ...record, targetKind: source.targetKind, expiresAt: full.expiresAt, deliveryMaterial: stored.deliveryMaterial,
      });
      const reader = index(backend);
      expect((await reader.reconcile()).admitted).toBe(0);
      const loaded = await reader.load();
      expect(loaded.status === "ok" ? loaded.doc.rows[key] : undefined).toBeUndefined();
    });
  }

  test("admits genuinely expired full-link history while recipient opening observes the actual clock", async () => {
    setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const full = await published();
      const parsed = parseLink(full.link!, { trustedOrigins: [SHARE_ORIGIN] });
      if (parsed.form !== "full") throw new Error("expected publisher full link");
      expect((await openLinkRecord(parsed.record, parsed.key)).value).toMatchObject({ shareId: full.shareId });
      const backend = new MemoryBackend();
      await new AgentShareRecordStore({ backend, agentDid: ownerDid }).put(full);
      setSystemTime(new Date(Date.parse(full.expiresAt) + 1));
      await expect(openLinkRecord(parsed.record, parsed.key)).rejects.toThrow();
      const reader = index(backend);
      expect(await reader.reconcile()).toMatchObject({ admitted: 1, rejected: {} });
      const loaded = await reader.load();
      if (loaded.status !== "ok") throw new Error("expected owner index");
      expect(loaded.doc.rows[agentRecordKey(agentIdFromDid(ownerDid), full.shareId)]).toMatchObject({ ps: "proven", pe: true });
      expect((await expandShareRecord(await compactShareRecord(full))).link).toBe(full.link);
    } finally { setSystemTime(); }
  });

  test("checks reconstructed origin and original signature before canonical admission", async () => {
    const full = await published();
    const stored = await compactShareRecord(full);
    const metadata = await originalMetadata(full.link!);
    const badSignature = fromBase64Url(metadata.signature.value); badSignature[0] = badSignature[0]! ^ 1;
    for (const fullLink of [{ ...metadata, origin: "https://foreign-renderer.test" }, { ...metadata, signature: { ...metadata.signature, value: toBase64Url(badSignature) } }, { ...metadata, header: { ...metadata.header, nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) } }]) {
      const backend = new MemoryBackend();
      await writePayload(backend, full.shareId, ownerDid, { ...stored, deliveryMaterial: { ...stored.deliveryMaterial, fullLink } });
      expect(await index(backend).reconcile()).toMatchObject({ admitted: 0, rejected: { link: 1 } });
    }
  });

  test("refuses an outer header re-signed by a different key than the actual inner envelope signer", async () => {
    const full = await published(); const material = full.deliveryMaterial!;
    const key = fromBase64Url(material.envelopeKey);
    const prepared = await prepareLinkRecord({ type: "share", sealed: { blob: fromBase64Url(material.sealedEnvelope), key }, issuerKey: signerFromSeed(foreignSeed), apiOrigin: "https://api.tinycloud.xyz", expiresAt: new Date(full.expiresAt), enforceServiceLife: false });
    const link = buildFullLink({ origin: SHARE_ORIGIN, key, record: prepared.record });
    await expect(compactShareRecord({ ...full, link })).rejects.toThrow();
  });

  test("artifact layout stays exact, versioned, traversal-free and bound to the authenticated owner", async () => {
    const full = await published(true); const stored = await compactShareRecord(full);
    const context = { recordV: 1, shareId: full.shareId, accountOwnerDid: OWNER_DID, agentDid: ownerDid, source: "agent" as const };
    expect(checkAgentRecordSchema(stored, context).resource).toEqual(full.resource);
    for (const path of ["artifacts/art_history/versions/0/note.txt", "artifacts/art_history/versions/07/note.txt", "artifacts/art_history/versions/7/files/note.txt", "artifacts/art_history/versions/7/../note.txt", "artifacts/art_history/current/note.txt", "artifacts/art_history/versions/7/"]) {
      expect(() => checkAgentRecordSchema({ ...stored, resource: { kind: "exact", path } }, context)).toThrow("schema");
    }
    expect(() => checkAgentRecordSchema({ ...stored, resource: { ...stored.resource, kind: "prefix" } }, context)).toThrow("schema");
    expect(() => checkAgentRecordSchema(stored, { ...context, accountOwnerDid: OWNER_DID.replace(":1:", ":137:") })).toThrow("schema");
    expect(() => checkAgentRecordSchema({ ...stored, actions: ["tinycloud.kv/put"] }, context)).toThrow("schema");
  });

  test("legacy three-field material stays readable without inventing a missing full link", async () => {
    const full = await published();
    const stored = await compactShareRecord(full);
    const { fullLink: _original, ...legacy } = stored.deliveryMaterial!;
    const record = { ...stored, deliveryMaterial: legacy };
    expect((await expandShareRecord(record)).link).toBeUndefined();
    const backend = new MemoryBackend();
    await writePayload(backend, full.shareId, ownerDid, record);
    expect(await index(backend).reconcile()).toMatchObject({ admitted: 1, rejected: {} });
  });

  test("the metadata shape rejects duplicated bodies, extra header/signature fields and missing signed data", async () => {
    const full = await published(); const stored = await compactShareRecord(full);
    const original = await originalMetadata(full.link!);
    const context = { recordV: 1, shareId: full.shareId, accountOwnerDid: OWNER_DID, agentDid: ownerDid, source: "agent" as const };
    for (const fullLink of [
      { ...original, body: stored.deliveryMaterial!.sealedEnvelope },
      { ...original, header: { ...original.header, extra: true } },
      { ...original, signature: { ...original.signature, extra: true } },
      { origin: original.origin, header: original.header },
      { ...original, origin: "http://share.test" },
    ]) expect(() => checkAgentRecordSchema({ ...stored, deliveryMaterial: { ...stored.deliveryMaterial, fullLink } }, context)).toThrow("schema");
  });

  test("body, key and CID tampering refuses before a cached proof could admit the row", async () => {
    const full = await published(); const stored = await compactShareRecord(full);
    const material = stored.deliveryMaterial!;
    const body = fromBase64Url(material.sealedEnvelope); body[body.length - 1] = body[body.length - 1]! ^ 1;
    const another = await published();
    for (const deliveryMaterial of [
      { ...material, sealedEnvelope: toBase64Url(body) },
      { ...material, envelopeKey: toBase64Url(crypto.getRandomValues(new Uint8Array(32))) },
      { ...material, shareCid: another.deliveryMaterial!.shareCid },
    ]) {
      const backend = new MemoryBackend();
      await writePayload(backend, full.shareId, ownerDid, { ...stored, deliveryMaterial });
      expect(await index(backend).reconcile()).toMatchObject({ admitted: 0, rejected: { link: 1 } });
    }
  });

  test("a valid new outer signature cannot extend the original sealed share expiry", async () => {
    const full = await published(); const material = full.deliveryMaterial!;
    const key = fromBase64Url(material.envelopeKey);
    const prepared = await prepareLinkRecord({ type: "share", sealed: { blob: fromBase64Url(material.sealedEnvelope), key }, issuerKey: signerFromSeed(ownerSeed), apiOrigin: "https://api.tinycloud.xyz", expiresAt: new Date(Date.parse(full.expiresAt) + 60_000), enforceServiceLife: false });
    await expect(compactShareRecord({ ...full, link: buildFullLink({ origin: SHARE_ORIGIN, key, record: prepared.record }) })).rejects.toThrow("expiry");
  });

  test("artifact pin admission uses the signed version independently of recipient metadata", async () => {
    const full = await published(true);
    const { signature: _signature, ...unsigned } = shareEnvelopeV3Schema.parse(full.deliveryMaterial!.envelope);
    const wrong = signEnvelopeV3({ ...unsigned, artifactPin: { ...unsigned.artifactPin!, version: 8 } }, ownerSeed);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await seal(new TextEncoder().encode(canonicalize(wrong)), key);
    const prepared = await prepareLinkRecord({ type: "share", sealed: { blob: sealed.blob, key }, issuerKey: signerFromSeed(ownerSeed), apiOrigin: "https://api.tinycloud.xyz", expiresAt: new Date(full.expiresAt), enforceServiceLife: false });
    const changed: SenderShareRecord = { ...full, recipientMatcher: { kind: "bearer" }, shareCid: sealed.cid, envelopeCid: sealed.cid, link: buildFullLink({ origin: SHARE_ORIGIN, key, record: prepared.record }), deliveryMaterial: { envelope: wrong, shareCid: sealed.cid, sealedEnvelope: toBase64Url(sealed.blob), envelopeKey: toBase64Url(key) } };
    const backend = new MemoryBackend();
    await new AgentShareRecordStore({ backend, agentDid: ownerDid }).put(changed);
    expect(await index(backend).reconcile()).toMatchObject({ admitted: 0, rejected: { proof: 1 } });
  });
});
