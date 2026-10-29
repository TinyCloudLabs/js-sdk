import { describe, expect, test } from "bun:test";
import { canonicalize, fromBase64Url, seal, toBase64Url } from "@tinycloud/share-envelope";
import { buildFullLink, buildShortLink, prepareLinkRecord, signerFromSeed } from "@tinycloud/share-envelope/links";
import type { SenderShareRecord } from "../../src/history.js";
import { createTinyCloudShareIndexBackend, type TinyCloudShareIndexClient } from "../../src/share-index/backend.js";
import { sealAgentRecord } from "../../src/share-index/agent-record.js";
import { compactShareRecord, expandShareRecord, openDeliveryEnvelope, type StoredShareRecord } from "../../src/share-index/delivery.js";
import { MAX_AGENT_RECORD_BYTES } from "../../src/share-index/agent-record.js";
import { openAgentRecordAsOwner, parseStoredAgentRecord } from "../../src/share-index/agent-record.js";
import { agentIdFromDid, agentRecordKey, SHARE_RECORDS_VAULT_PREFIX } from "../../src/share-index/ids.js";
import { AgentShareRecordStore } from "../../src/share-index/record-store.js";
import { MemoryShareIndexOutbox, SenderShareIndex } from "../../src/share-index/sender-share-index.js";
import { verifyAgentRecordChain } from "../../src/share-index/verify/chain.js";
import { checkAgentRecordSchema } from "../../src/share-index/schema.js";
import v3Fixture from "./fixtures/v3-envelope.json";
import { fakeSiwe, fakeSiweParser, MemoryBackend, NETWORK_ID, newKey, SHARE_ORIGIN, SPACE_ID } from "./helpers.js";

/**
 * The stored form (cap ruling): a Policy/v3 record stores each blob once.
 * The envelope is what `sealedEnvelope` decrypts to; it is omitted and reopened
 * exactly. A short `v=4` link is kept; a full link is not.
 */
const encoder = new TextEncoder();
const v3 = v3Fixture.v3;
const now = new Date(v3Fixture.generatedAt);

/** The link the fixture share's sealed material gets: the short link, or the full link a record carries in its fragment. */
async function linkFor(form: "short" | "full", blob: Uint8Array, cid: string, key: Uint8Array): Promise<string> {
  if (form === "short") return buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: "lqdw5iopqq2tkkvjj6gbbi5vbv", key, bodyCid: cid });
  const { record } = await prepareLinkRecord({
    type: "share",
    sealed: { blob, key },
    issuerKey: signerFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    apiOrigin: "https://api.tinycloud.xyz",
    expiresAt: new Date(Date.now() + 3600_000),
    enforceServiceLife: false,
  });
  return buildFullLink({ origin: SHARE_ORIGIN, key, record });
}

/**
 * The record `historyRecordForPublishedShare` would write for the fixture share: envelope, sealed material and link
 * (the short link by default; `"full"` for the link a share past 30 days gets).
 */
async function fullRecord(form: "short" | "full" = "short"): Promise<SenderShareRecord> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await seal(encoder.encode(canonicalize(v3.envelope)), key);
  const material = { envelope: v3.envelope, shareCid: sealed.cid, sealedEnvelope: toBase64Url(sealed.blob), envelopeKey: toBase64Url(key) };
  const envelope = v3.envelope as unknown as { policy: { ownerDid: string } };
  const siwe = fakeSiwe({
    issuer: v3Fixture.ownerDid, audience: envelope.policy.ownerDid, expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    attenuation: { [`${v3.target.spaceId}/kv`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/metadata": [{}] }, [`urn:tinycloud:encryption:${v3Fixture.ownerDid}:default`]: { "tinycloud.encryption/decrypt": [{}] } },
  });
  return {
    shareId: v3.shareId, target: v3.target, resource: v3.resource as SenderShareRecord["resource"], actions: ["tinycloud.kv/get"], recipientMatcher: v3.recipientMatcher as SenderShareRecord["recipientMatcher"],
    // expiresAt exactly as publishAddressedShare writes it (whole seconds, no fraction).
    targetKind: "recipientDid", registeredAt: v3.registeredAt, expiresAt: v3.expiresAt, policyCid: v3.policyCid, ownerDelegationCid: v3.policyRootCid, enforcementDelegationCid: v3.enforcementRootCid,
    envelopeCid: sealed.cid, shareCid: sealed.cid, filename: "doc.txt",
    link: await linkFor(form, sealed.blob, sealed.cid, key),
    deliveryMaterial: material as SenderShareRecord["deliveryMaterial"] & object, proofs: { session: siwe.authorization },
  };
}

describe("stored form: each blob once", () => {
  test("compaction omits the envelope and keeps the short link; expansion restores the full record exactly", async () => {
    const full = await fullRecord();
    const stored = await compactShareRecord(full);
    expect(stored.link).toBe(full.link!);
    expect(await expandShareRecord(stored)).toEqual(full);
    // A bearer link is not derivable and stays; compaction is a no-op without delivery material.
    const bearer = { ...full, deliveryMaterial: undefined, link: `${SHARE_ORIGIN}/viewer#tc1=opaque-token` };
    delete (bearer as { deliveryMaterial?: unknown }).deliveryMaterial;
    expect(await compactShareRecord(bearer)).toEqual(bearer);
  });


  test("compaction refuses a record whose envelope or link is not its sealed material's", async () => {
    const full = await fullRecord();
    const otherEnvelope = { ...structuredClone(v3.envelope), shareId: "other" };
    await expect(compactShareRecord({ ...full, deliveryMaterial: { ...full.deliveryMaterial!, envelope: otherEnvelope } })).rejects.toThrow("envelope is not the sealed envelope");
    const other = await fullRecord();
    await expect(compactShareRecord({ ...full, link: other.link! })).rejects.toThrow("link");
    await expect(compactShareRecord({ ...full, link: (await fullRecord("full")).link! })).rejects.toThrow("link");
    await expect(compactShareRecord({ ...full, link: `${SHARE_ORIGIN}/viewer#tc1=opaque-token` })).rejects.toThrow("link");
    await expect(compactShareRecord({ ...full, link: `${SHARE_ORIGIN}/s/inline#v=2&p=eyJ2IjoyfQ` })).rejects.toThrow("link");
  });

  test("the sealed envelope must match shareCid, open under its key, and be canonical JSON", async () => {
    const stored = await compactShareRecord(await fullRecord());
    const material = stored.deliveryMaterial!;
    expect(await openDeliveryEnvelope(material)).toEqual(v3.envelope as Record<string, unknown>);
    const flipped = fromBase64Url(material.sealedEnvelope);
    flipped[flipped.length - 1] = flipped[flipped.length - 1]! ^ 1;
    await expect(openDeliveryEnvelope({ ...material, sealedEnvelope: toBase64Url(flipped) })).rejects.toThrow("shareCid");
    const wrongKey = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await expect(openDeliveryEnvelope({ ...material, envelopeKey: wrongKey })).rejects.toThrow("does not open");
    // Same envelope, sealed as non-canonical JSON (with whitespace): refused.
    const key = crypto.getRandomValues(new Uint8Array(32));
    const loose = await seal(encoder.encode(JSON.stringify(v3.envelope, null, 1)), key);
    await expect(openDeliveryEnvelope({ shareCid: loose.cid, sealedEnvelope: toBase64Url(loose.blob), envelopeKey: toBase64Url(key) })).rejects.toThrow("canonical");
  });

});

describe("the chain verifies the stored form", () => {
  const context = (agentDid: string) => ({ accountOwnerDid: v3Fixture.ownerDid, agentDid, now, parseSiweCacao: fakeSiweParser });

  test("proven from the sealed material; a record naming another sealed envelope, or sealed material of another envelope, is refused", async () => {
    const stored = await compactShareRecord(await fullRecord());
    expect(await verifyAgentRecordChain(stored, context(v3Fixture.agentDid))).toMatchObject({ ok: true, state: "proven" });
    const other = await compactShareRecord(await fullRecord());
    expect((await verifyAgentRecordChain({ ...stored, shareCid: other.deliveryMaterial!.shareCid }, context(v3Fixture.agentDid))).ok).toBe(false);
    expect((await verifyAgentRecordChain({ ...stored, envelopeCid: other.deliveryMaterial!.shareCid }, context(v3Fixture.agentDid))).ok).toBe(false);
    // Genuine sealed material, but of an envelope this record does not name (another share id): refused.
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sealedOther = await seal(encoder.encode(canonicalize({ ...structuredClone(v3.envelope), shareId: "other" })), key);
    const foreign: StoredShareRecord = { ...stored, shareCid: sealedOther.cid, envelopeCid: sealedOther.cid, deliveryMaterial: { shareCid: sealedOther.cid, sealedEnvelope: toBase64Url(sealedOther.blob), envelopeKey: toBase64Url(key) } };
    expect((await verifyAgentRecordChain(foreign, context(v3Fixture.agentDid))).ok).toBe(false);
    // Without delivery material there is nothing to verify.
    const { deliveryMaterial: _material, ...bare } = stored;
    expect((await verifyAgentRecordChain(bare, context(v3Fixture.agentDid))).ok).toBe(false);
  });
});

describe("agent store and reconciler use the stored form", () => {
  async function ownerIndex(backend: MemoryBackend) {
    return new SenderShareIndex({ backend, outbox: new MemoryShareIndexOutbox(), ownerDid: v3Fixture.ownerDid, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser, now: () => now, cas: { sleep: async () => {} } });
  }

  async function writeRaw(backend: MemoryBackend, record: unknown): Promise<string> {
    const key = agentRecordKey(agentIdFromDid(v3Fixture.agentDid), v3.shareId);
    // The CLI's key is not in the fixture: seal without KEK_a (owner-readable only), as a remote-signer profile does.
    const stored = await sealAgentRecord({ plaintext: encoder.encode(JSON.stringify(record)), spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}`, agentDid: v3Fixture.agentDid, ownerNetworkId: NETWORK_ID, ownerWrap: backend.network });
    await backend.writeRaw(key, stored as unknown as Record<string, unknown>, { ifNoneMatch: "*" });
    return key;
  }

  test("the agent store writes the stored form; the owner admits it proven", async () => {
    const backend = new MemoryBackend();
    const store = new AgentShareRecordStore({ backend, agentDid: v3Fixture.agentDid });
    const full = await fullRecord();
    await store.put(full);
    const key = agentRecordKey(store.agentId, v3.shareId);
    const stored = await compactShareRecord(full);
    const index = await ownerIndex(backend);
    expect(await index.reconcile()).toMatchObject({ admitted: 1, rejected: {} });
    const loaded = await index.load();
    expect(loaded.status === "ok" && loaded.doc.rows[key]).toMatchObject({ ps: "proven", ak: "recipientDid" });
    expect(JSON.stringify(stored)).not.toContain(JSON.stringify(v3.envelope));
  });

  test("a record that stores the envelope again, a full link, or another share's link is refused", async () => {
    const full = await fullRecord();
    const stored = await compactShareRecord(full);
    const context = { recordV: 1, shareId: v3.shareId, accountOwnerDid: v3Fixture.ownerDid, agentDid: v3Fixture.agentDid, source: "agent" as const };
    expect(checkAgentRecordSchema(JSON.parse(JSON.stringify(stored)), context)).toBeDefined();
    const duplicates: [StoredShareRecord, Record<string, number>, boolean][] = [
      [{ ...stored, deliveryMaterial: full.deliveryMaterial! }, { schema: 1 }, true],
      // A full link is sealedEnvelope base64'd twice: over the 32 KiB cap, which the reconciler enforces before the schema.
      [{ ...stored, link: (await fullRecord("full")).link! }, { size: 1 }, false],
      // A short link that is not this record's own material's: it passes the schema and is refused as a link.
      [{ ...stored, link: (await fullRecord()).link! }, { link: 1 }, false],
    ];
    for (const [duplicate, rejected, schemaRefuses] of duplicates) {
      if (schemaRefuses) expect(() => checkAgentRecordSchema(JSON.parse(JSON.stringify(duplicate)), context)).toThrow("schema");
      const backend = new MemoryBackend();
      await writeRaw(backend, duplicate);
      expect((await (await ownerIndex(backend)).reconcile()).rejected).toEqual(rejected);
    }
    const backend = new MemoryBackend();
    await writeRaw(backend, stored);
    expect(await (await ownerIndex(backend)).reconcile()).toMatchObject({ admitted: 1, rejected: {} });
  });

  test("an agent reads back its original legacy short link and delivery material", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const { deriveAgentKeyMaterial } = await import("../../src/share-index/agent-key.js");
    const agentKey = await deriveAgentKeyMaterial(agent.privateKey, agent.did);
    const full = await fullRecord();
    await new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey }).put(full);
    expect(await new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey }).get(v3.shareId)).toEqual(full);
  });

  test("what the agent store writes is the stored form: no envelope, the short link, the sealed material, under the record cap", async () => {
    const backend = new MemoryBackend();
    const store = new AgentShareRecordStore({ backend, agentDid: v3Fixture.agentDid });
    const full = await fullRecord();
    await store.put(full);
    const key = agentRecordKey(store.agentId, v3.shareId);
    const raw = await backend.readRaw(key);
    if (raw.status !== "ok") throw new Error(`stored record is ${raw.status}`);
    expect(raw.bytes.byteLength).toBeLessThanOrEqual(MAX_AGENT_RECORD_BYTES);
    const record = parseStoredAgentRecord(raw.bytes, { agentDid: v3Fixture.agentDid, ownerNetworkId: NETWORK_ID });
    const plaintext = await openAgentRecordAsOwner(record, { spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}` }, backend.network);
    const written = JSON.parse(new TextDecoder().decode(plaintext)) as StoredShareRecord;
    expect(written.link).toBe(full.link);
    expect(new TextDecoder().decode(plaintext)).not.toContain(JSON.stringify(v3.envelope));
    expect(written).toEqual(await compactShareRecord(full));
  });


  test("the schema refuses a full link stored beside delivery material, with a record far under the size cap", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const small = await seal(encoder.encode("{}"), key);
    const material = { shareCid: small.cid, sealedEnvelope: toBase64Url(small.blob), envelopeKey: toBase64Url(key) };
    const { record } = await prepareLinkRecord({
      type: "share",
      sealed: { blob: small.blob, key },
      issuerKey: signerFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
      apiOrigin: "https://api.tinycloud.xyz",
      expiresAt: new Date(Date.now() + 3600_000),
      enforceServiceLife: false,
    });
    const fullLink = buildFullLink({ origin: SHARE_ORIGIN, key, record });
    const shortLink = buildShortLink({ origin: SHARE_ORIGIN, type: "share", id: "lqdw5iopqq2tkkvjj6gbbi5vbv", key, bodyCid: small.cid });
    const stored = await compactShareRecord(await fullRecord());
    const context = { recordV: 1, shareId: v3.shareId, accountOwnerDid: v3Fixture.ownerDid, agentDid: v3Fixture.agentDid, source: "agent" as const };
    const withLink = (link: string): StoredShareRecord => ({ ...stored, deliveryMaterial: material, link });

    const duplicate = withLink(fullLink);
    expect(() => checkAgentRecordSchema(JSON.parse(JSON.stringify(duplicate)), context)).toThrow("schema");
    expect(() => checkAgentRecordSchema(JSON.parse(JSON.stringify(withLink(`${SHARE_ORIGIN}/s/inline#v=2&p=YWJj`))), context)).toThrow("schema");
    expect(checkAgentRecordSchema(JSON.parse(JSON.stringify(withLink(shortLink))), context).link).toBe(shortLink);
    // The same full link on a record with no delivery material (a bearer record) is not this rule's concern.
    const { deliveryMaterial: _material, ...bearer } = duplicate;
    expect(() => checkAgentRecordSchema(JSON.parse(JSON.stringify(bearer)), context)).not.toThrow("schema");
  });
});

describe("the adapter refuses an oversize value before downloading it", () => {
  const ok = <T>(data: T) => ({ ok: true as const, data });
  /** A node that honours `maxResponseBytes` (413 before the body) unless `ignoresLimit`. */
  function client(options: { readonly body: Uint8Array; readonly ignoresLimit?: boolean }) {
    const limits: (number | undefined)[] = [];
    const value: TinyCloudShareIndexClient = {
      vault: { readNetworkEncrypted: async () => ({ status: "not_found" }), put: async () => ok({}), delete: async () => ok({}) },
      kv: {
        get: async (_key, getOptions) => {
          limits.push(getOptions.maxResponseBytes);
          if (options.ignoresLimit !== true && getOptions.maxResponseBytes !== undefined && options.body.byteLength > getOptions.maxResponseBytes) {
            return { ok: false as const, error: { code: "KV_RESPONSE_TOO_LARGE", meta: { status: 413 } } };
          }
          return ok({ data: options.body, headers: { etag: "\"e\"" } });
        },
        put: async () => ok({}), list: async () => ok({ keys: [] }),
      },
      encryption: { encryptToNetwork: async () => ok({}) },
    };
    return { limits, backend: createTinyCloudShareIndexBackend({ client: value, spaceId: SPACE_ID, ownerNetworkId: NETWORK_ID }) };
  }

  test("the cap is sent as maxResponseBytes; the node's refusal is `too_large`; a value at the cap is read", async () => {
    const over = client({ body: new Uint8Array(32 * 1024 + 1) });
    expect(await over.backend.readRaw("agents/a/s", 32 * 1024)).toEqual({ status: "too_large" });
    expect(over.limits).toEqual([32 * 1024]);
    const at = client({ body: new Uint8Array(32 * 1024) });
    expect((await at.backend.readRaw("agents/a/s", 32 * 1024)).status).toBe("ok");
  });

  test("a body over the cap is refused even when the limit was not honoured; without a cap none is sent", async () => {
    const ignoring = client({ body: new Uint8Array(32 * 1024 + 1), ignoresLimit: true });
    expect(await ignoring.backend.readRaw("agents/a/s", 32 * 1024)).toEqual({ status: "too_large" });
    const uncapped = client({ body: new Uint8Array(64 * 1024) });
    expect((await uncapped.backend.readRaw("agents/a/s")).status).toBe("ok");
    expect(uncapped.limits).toEqual([undefined]);
    // A size refusal the caller did not ask for is an outage, not a size verdict.
    const stray: TinyCloudShareIndexClient = {
      vault: { readNetworkEncrypted: async () => ({ status: "not_found" }), put: async () => ok({}), delete: async () => ok({}) },
      kv: { get: async () => ({ ok: false as const, error: { code: "KV_RESPONSE_TOO_LARGE" } }), put: async () => ok({}), list: async () => ok({ keys: [] }) },
      encryption: { encryptToNetwork: async () => ok({}) },
    };
    expect(await createTinyCloudShareIndexBackend({ client: stray, spaceId: SPACE_ID, ownerNetworkId: NETWORK_ID }).readRaw("agents/a/s")).toEqual({ status: "unavailable" });
  });

  test("the reconciler rejects a too-large value as `size`", async () => {
    const backend = new MemoryBackend();
    const key = await (async () => {
      const k = agentRecordKey(agentIdFromDid(v3Fixture.agentDid), v3.shareId);
      backend.putRawBytes(k, new Uint8Array(8));
      return k;
    })();
    const readRaw = backend.readRaw.bind(backend);
    const caps: (number | undefined)[] = [];
    backend.readRaw = async (rawKey: string, maxBytes?: number) => { caps.push(maxBytes); return rawKey === key ? { status: "too_large" } : readRaw(rawKey); };
    const index = new SenderShareIndex({ backend, outbox: new MemoryShareIndexOutbox(), ownerDid: v3Fixture.ownerDid, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser, cas: { sleep: async () => {} } });
    expect((await index.reconcile()).rejected).toEqual({ size: 1 });
    expect(caps).toContain(32 * 1024);
  });
});
