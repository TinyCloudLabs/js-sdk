import { describe, expect, test } from "bun:test";
import { canonicalize, encodeSealedInlineShareUrl, fromBase64Url, parseSealedInlineShareUrl, seal, toBase64Url } from "@tinycloud/share-envelope";
import type { SenderShareRecord } from "../../src/history.js";
import { createTinyCloudShareIndexBackend, type TinyCloudShareIndexClient } from "../../src/share-index/backend.js";
import { sealAgentRecord } from "../../src/share-index/agent-record.js";
import { compactShareRecord, expandShareRecord, openDeliveryEnvelope, shareLinkForRecord, type StoredShareRecord } from "../../src/share-index/delivery.js";
import { agentIdFromDid, agentRecordKey, SHARE_RECORDS_VAULT_PREFIX } from "../../src/share-index/ids.js";
import { AgentShareRecordStore } from "../../src/share-index/record-store.js";
import { MemoryShareIndexOutbox, SenderShareIndex } from "../../src/share-index/sender-share-index.js";
import { verifyAgentRecordChain } from "../../src/share-index/verify/chain.js";
import { checkAgentRecordSchema } from "../../src/share-index/schema.js";
import v3Fixture from "./fixtures/v3-envelope.json";
import { fakeSiwe, fakeSiweParser, MemoryBackend, NETWORK_ID, newKey, SHARE_ORIGIN, SPACE_ID } from "./helpers.js";

/**
 * The stored form (cap ruling): a Policy/v3 record stores each blob once.
 * The envelope is what `sealedEnvelope` decrypts to and the `/s/inline` link
 * re-encodes `sealedEnvelope`; both are dropped and rebuilt exactly.
 */
const encoder = new TextEncoder();
const v3 = v3Fixture.v3;
const now = new Date(v3Fixture.generatedAt);

/** The record `historyRecordForPublishedShare` would write for the fixture share: envelope, sealed material and link. */
async function fullRecord(): Promise<SenderShareRecord> {
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
    link: await encodeSealedInlineShareUrl({ origin: SHARE_ORIGIN, ciphertext: sealed.blob, key32: key }),
    deliveryMaterial: material as SenderShareRecord["deliveryMaterial"] & object, proofs: { session: siwe.authorization },
  };
}

describe("stored form: each blob once", () => {
  test("compaction drops the envelope and the inline link; both are rebuilt exactly", async () => {
    const full = await fullRecord();
    const stored = await compactShareRecord(full);
    expect(stored.link).toBeUndefined();
    expect(Object.keys(stored.deliveryMaterial!).sort()).toEqual(["envelopeKey", "sealedEnvelope", "shareCid"]);
    expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(full).length - JSON.stringify(v3.envelope).length);
    // Open/Copy rebuilds the very same link on the configured origin, and it parses back to the stored material.
    const link = await shareLinkForRecord(stored, SHARE_ORIGIN);
    expect(link).toBe(full.link!);
    const parsed = await parseSealedInlineShareUrl(link!, { expectedOrigin: SHARE_ORIGIN });
    expect(parsed.ciphertextCid).toBe(stored.deliveryMaterial!.shareCid);
    expect(toBase64Url(parsed.key32)).toBe(stored.deliveryMaterial!.envelopeKey);
    expect(await expandShareRecord(stored, SHARE_ORIGIN)).toEqual(full);
    // A bearer link is not derivable and stays; compaction is a no-op without delivery material.
    const bearer = { ...full, deliveryMaterial: undefined, link: `${SHARE_ORIGIN}/viewer#tc1=opaque-token` };
    delete (bearer as { deliveryMaterial?: unknown }).deliveryMaterial;
    expect(await compactShareRecord(bearer)).toEqual(bearer);
    expect(await shareLinkForRecord(bearer, SHARE_ORIGIN)).toBe(bearer.link);
  });

  test("compaction refuses a record whose envelope or link is not its sealed material's", async () => {
    const full = await fullRecord();
    const otherEnvelope = { ...structuredClone(v3.envelope), shareId: "other" };
    await expect(compactShareRecord({ ...full, deliveryMaterial: { ...full.deliveryMaterial!, envelope: otherEnvelope } })).rejects.toThrow("envelope is not the sealed envelope");
    const other = await fullRecord();
    await expect(compactShareRecord({ ...full, link: other.link! })).rejects.toThrow("link");
    await expect(compactShareRecord({ ...full, link: `${SHARE_ORIGIN}/viewer#tc1=opaque-token` })).rejects.toThrow("link");
    await expect(compactShareRecord({ ...full, deliveryMaterial: { ...full.deliveryMaterial!, shareCid: other.deliveryMaterial!.shareCid } })).rejects.toThrow("shareCid");
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
    // What the owner decrypts carries no envelope and no link.
    const index = await ownerIndex(backend);
    expect(await index.reconcile()).toMatchObject({ admitted: 1, rejected: {} });
    const loaded = await index.load();
    expect(loaded.status === "ok" && loaded.doc.rows[key]).toMatchObject({ ps: "proven", ak: "recipientDid" });
    const raw = await backend.readRaw(key);
    expect(raw.status === "ok" && new TextDecoder().decode(raw.bytes)).not.toContain(full.link!);
  });

  test("a record that stores the envelope or the inline link again is refused (schema; size once it is over the cap)", async () => {
    const full = await fullRecord();
    const stored = await compactShareRecord(full);
    const context = { recordV: 1, shareId: v3.shareId, accountOwnerDid: v3Fixture.ownerDid, agentDid: v3Fixture.agentDid, source: "agent" as const };
    expect(checkAgentRecordSchema(JSON.parse(JSON.stringify(stored)), context)).toBeDefined();
    const duplicates: [StoredShareRecord, Record<string, number>][] = [
      [{ ...stored, deliveryMaterial: full.deliveryMaterial! }, { schema: 1 }],
      // The link is sealedEnvelope base64'd twice: over the 32 KiB cap before the schema is reached.
      [{ ...stored, link: full.link! }, { size: 1 }],
    ];
    for (const [duplicate, rejected] of duplicates) {
      expect(() => checkAgentRecordSchema(JSON.parse(JSON.stringify(duplicate)), context)).toThrow("schema");
      const backend = new MemoryBackend();
      await writeRaw(backend, duplicate);
      expect((await (await ownerIndex(backend)).reconcile()).rejected).toEqual(rejected);
    }
    const backend = new MemoryBackend();
    await writeRaw(backend, stored);
    expect(await (await ownerIndex(backend)).reconcile()).toMatchObject({ admitted: 1, rejected: {} });
  });

  test("an agent reading its own record back gets the full record, with the link on its configured origin", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const { deriveAgentKeyMaterial } = await import("../../src/share-index/agent-key.js");
    const agentKey = await deriveAgentKeyMaterial(agent.privateKey, agent.did);
    const full = await fullRecord();
    await new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey }).put(full);
    expect(await new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey, shareOrigin: SHARE_ORIGIN }).get(v3.shareId)).toEqual(full);
    const { link: _link, ...withoutLink } = full;
    expect(await new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey }).get(v3.shareId)).toEqual(withoutLink);
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
