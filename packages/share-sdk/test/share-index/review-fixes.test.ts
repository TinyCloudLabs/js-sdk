import { describe, expect, test } from "bun:test";
import { fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import type { SenderShareRecord } from "../../src/history.js";
import type { StoredShareRecord } from "../../src/share-index/delivery.js";
import { createTinyCloudShareIndexBackend, type TinyCloudShareIndexClient } from "../../src/share-index/backend.js";
import { deriveAgentKeyMaterial } from "../../src/share-index/agent-key.js";
import { agentRecordBinding, openAgentRecordAsOwner, sealAgentRecord, type StoredAgentRecord } from "../../src/share-index/agent-record.js";
import { agentIdFromDid, agentRecordKey, INDEX_MAIN_KEY, SHARE_RECORDS_VAULT_PREFIX } from "../../src/share-index/ids.js";
import { AgentShareRecordStore } from "../../src/share-index/record-store.js";
import { headerBytes, MemoryShareIndexOutbox, SenderShareIndex, type ShareIndexLimits } from "../../src/share-index/sender-share-index.js";
import { project, type ShareIndexDocument, type ShareIndexRow } from "../../src/share-index/schema.js";
import { verifyAgentRecordChain } from "../../src/share-index/verify/chain.js";
import { verifyEnvelopeV3At } from "../../src/share-index/verify/policy-v3.js";
import type { ShareEnvelopeV3 } from "@tinycloud/share-envelope";
import { cacaoTimes } from "../../src/share-index/verify/cacao-times.js";
import { parseSignedUcan } from "../../src/share-index/verify/ucan.js";
import v3Fixture from "./fixtures/v3-envelope.json";
import {
  bearerFixture, CONTENT_SPACE_ID, fakeSiwe, fakeSiweParser, FakeOwnerNetwork, MemoryBackend, NETWORK_ID, newKey, OWNER_DID, SHARE_ORIGIN, sealDeliveryMaterial, signUcan, SPACE_ID, type TestKey,
} from "./helpers.js";

/**
 * Review round on #587: signed-time `registeredAt` (M2), owner-space content
 * (M3), the header cap (m1), the per-agent allowance (m2), and tests for the
 * guards the mutation run left uncovered.
 */
const encoder = new TextEncoder();
const DAY = 86_400_000;

function owner(backend: MemoryBackend, limits: Partial<ShareIndexLimits> = {}) {
  return new SenderShareIndex({ backend, outbox: new MemoryShareIndexOutbox(), ownerDid: OWNER_DID, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser, limits, cas: { sleep: async () => {} } });
}

async function writeAgentRecord(backend: MemoryBackend, agent: TestKey, record: SenderShareRecord | Record<string, unknown>): Promise<string> {
  const key = agentRecordKey(agentIdFromDid(agent.did), String(record.shareId));
  const stored = await sealAgentRecord({ plaintext: encoder.encode(JSON.stringify(record)), spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}`, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: backend.network, agentKey: await deriveAgentKeyMaterial(agent.privateKey, agent.did) });
  await backend.writeRaw(key, stored as unknown as Record<string, unknown>, { ifNoneMatch: "*" });
  return key;
}

async function doc(index: SenderShareIndex): Promise<ShareIndexDocument> {
  const loaded = await index.load();
  if (loaded.status !== "ok") throw new Error(`index is ${loaded.status}`);
  return loaded.doc;
}

/** A genuine agent share published `daysAgo` days before the owner first opens Share. */
function publishedDaysAgo(agent: TestKey, daysAgo: number, shareId: string) {
  const published = new Date(Date.now() - daysAgo * DAY);
  return bearerFixture({ session: agent, shareId, now: published, expSeconds: 60 * 86_400, siwe: { issuedAt: published.toISOString(), expiresAt: new Date(Date.now() + 20 * DAY).toISOString() } });
}

describe("M2: registeredAt is checked against signed times, not first sight", () => {
  test("an agent share published 10 days before the owner's first load is admitted (reviewer reproduction)", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const key = await writeAgentRecord(backend, agent, publishedDaysAgo(agent, 10, "ten").record);
    const index = owner(backend);
    expect(await index.reconcile()).toMatchObject({ admitted: 1, rejected: {} });
    expect((await doc(index)).rows[key]).toMatchObject({ ps: "proven" });
  });

  test("registeredAt more than a day before the session's signed Issued At, or in the future, is rejected `schema`", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const early = publishedDaysAgo(agent, 1, "early");
    await writeAgentRecord(backend, agent, { ...early.record, registeredAt: new Date(Date.now() - 3 * DAY).toISOString() });
    const future = bearerFixture({ session: agent, shareId: "future" });
    await writeAgentRecord(backend, agent, { ...future.record, registeredAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect((await owner(backend).reconcile()).rejected).toEqual({ schema: 2 });
  });

  test("with a signed link nbf, registeredAt must lie within a day of it (both bounds)", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const nbf = Math.floor((Date.now() - 5 * DAY) / 1000);
    // The record's own expiry is far off, so only the window decides.
    const make = (shareId: string) => bearerFixture({ session: agent, shareId, now: new Date(nbf * 1000), expSeconds: 30 * 86_400, link: { nbf }, siwe: { expiresAt: new Date(Date.now() + DAY).toISOString() }, record: { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() } });
    const nearKey = await writeAgentRecord(backend, agent, { ...make("near").record, registeredAt: new Date(nbf * 1000 + 12 * 3_600_000).toISOString() });
    await writeAgentRecord(backend, agent, { ...make("far").record, registeredAt: new Date(nbf * 1000 + 2 * DAY).toISOString() });
    await writeAgentRecord(backend, agent, { ...make("before").record, registeredAt: new Date(nbf * 1000 - 2 * DAY).toISOString() });
    const index = owner(backend);
    expect((await index.reconcile()).rejected).toEqual({ schema: 2 });
    expect((await doc(index)).rows[nearKey]).toBeDefined();
  });
});

describe("M2 and the migrated ruling: only an owner import is exempt from the ±1-day anchor", () => {
  test("registeredAt 30 days before the link's signed nbf: an owner import is admitted, the same record from an agent is `schema`", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const nbf = Math.floor(Date.now() / 1000) - 3600;
    const make = (shareId: string) => bearerFixture({ session: agent, shareId, link: { nbf }, expSeconds: 30 * 86_400 });
    const backdated = new Date(nbf * 1000 - 30 * DAY).toISOString();
    await backend.writeVault("imported", { ...make("imported").record, registeredAt: backdated, provenance: "migrated" });
    await writeAgentRecord(backend, agent, { ...make("agentcopy").record, registeredAt: backdated });
    const index = owner(backend);
    expect((await index.reconcile()).rejected).toEqual({ schema: 1 });
    expect((await doc(index)).rows.imported).toMatchObject({ pv: "migrated", ps: "chained" });
    // Not exempt from the future bound.
    await backend.writeVault("futureimport", { ...make("futureimport").record, registeredAt: new Date(Date.now() + DAY).toISOString(), provenance: "migrated" });
    await index.reconcile();
    expect((await doc(index)).rows.futureimport).toMatchObject({ na: true });
  });

  test("an owner import is still held to the chain's latest bound (a day after the link's signed nbf)", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const nbf = Math.floor(Date.now() / 1000) - 10 * 86_400;
    const make = (shareId: string) => bearerFixture({ session: agent, shareId, now: new Date(nbf * 1000), link: { nbf }, expSeconds: 30 * 86_400, siwe: { expiresAt: new Date(Date.now() + DAY).toISOString() }, record: { expiresAt: new Date(Date.now() + 20 * DAY).toISOString() } });
    // Five days after the signed nbf, in the past: outside the window's latest bound, not in the future.
    await backend.writeVault("late", { ...make("late").record, registeredAt: new Date(nbf * 1000 + 5 * DAY).toISOString(), provenance: "migrated" });
    await backend.writeVault("ontime", { ...make("ontime").record, registeredAt: new Date(nbf * 1000 - 30 * DAY).toISOString(), provenance: "migrated" });
    const index = owner(backend);
    await index.reconcile();
    const rows = (await doc(index)).rows;
    expect(rows.late).toMatchObject({ na: true });
    expect(rows.ontime).toMatchObject({ pv: "migrated", ps: "chained" });
    expect(rows.ontime!.na).toBeUndefined();
  });
});

describe("M3: content may sit in any space of the account owner", () => {
  test("records in `applications`, content in `default` (the CLI layout): admitted; another owner's space: `schema`", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const cli = bearerFixture({ session: agent, shareId: "cli", contentSpace: CONTENT_SPACE_ID });
    const cliKey = await writeAgentRecord(backend, agent, cli.record);
    const foreign = bearerFixture({ session: agent, shareId: "foreign", contentSpace: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:default" });
    await writeAgentRecord(backend, agent, foreign.record);
    const index = owner(backend);
    expect((await index.reconcile()).rejected).toEqual({ schema: 1 });
    expect((await doc(index)).rows[cliKey]).toMatchObject({ ps: "proven" });
  });
});

describe("m1: a full header never blocks the owner's own updates and never evicts rows", () => {
  test("at the cap the reconciler adds no new agent state, still lands rows, and the owner's upsert is written", async () => {
    const backend = new MemoryBackend();
    // Fill the header with agents that each have rejections (under the default cap).
    for (let i = 0; i < 6; i++) {
      const junk = newKey();
      for (let j = 0; j < 5; j++) backend.putRawBytes(`agents/${agentIdFromDid(junk.did)}/x${j}/y`, encoder.encode("{}"));
    }
    await owner(backend).reconcile();
    const before = await doc(owner(backend));
    // Now the header sits at its cap.
    const index = owner(backend, { headerBytes: headerBytes(before) });
    // A new flooding agent and a genuine web record arrive.
    const flooder = newKey();
    for (let j = 0; j < 5; j++) backend.putRawBytes(`agents/${agentIdFromDid(flooder.did)}/bad${j}/y`, encoder.encode("{}"));
    const web = bearerFixture({ shareId: "web1" }).record;
    await backend.writeVault("web1", { ...web, provenance: undefined });
    const report = await index.reconcile();
    expect(report.headerFull).toBe(true);
    const after = await doc(index);
    expect(after.agents[agentIdFromDid(flooder.did)]).toBeUndefined();
    expect(after.rows.web1).toBeDefined();
    expect(Object.keys(after.rows).length).toBe(Object.keys(before.rows).length + 1);
    // The owner's own op still lands.
    await index.enqueue({ id: "own", type: "revoke", key: "web1", at: new Date().toISOString(), confirmed: true });
    expect((await index.flush()).status).toBe("written");
    expect((await doc(index)).rows.web1!.r).toMatchObject({ confirmed: true });
  });

  test("with the header already over its cap (for example after the cap is lowered), the owner's flush is still written", async () => {
    const backend = new MemoryBackend();
    for (let i = 0; i < 6; i++) {
      const junk = newKey();
      for (let j = 0; j < 5; j++) backend.putRawBytes(`agents/${agentIdFromDid(junk.did)}/x${j}/y`, encoder.encode("{}"));
    }
    await backend.writeVault("web1", bearerFixture({ shareId: "web1" }).record);
    await owner(backend).reconcile();
    const before = await doc(owner(backend));
    const index = owner(backend, { headerBytes: Math.floor(headerBytes(before) / 2) });
    expect(headerBytes(before)).toBeGreaterThan(Math.floor(headerBytes(before) / 2));
    await index.enqueue({ id: "own", type: "revoke", key: "web1", at: new Date().toISOString(), confirmed: true });
    expect((await index.flush()).status).toBe("written");
    const after = await doc(index);
    expect(after.rows.web1!.r).toMatchObject({ confirmed: true });
    // Nothing was evicted to make room.
    expect(Object.keys(after.agents)).toEqual(Object.keys(before.agents));
  });
});

describe("m2: every fetch spends the agent's 50-per-pass allowance", () => {
  test("60 bad records from one agent cost at most 50 fetches in a pass", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    for (let i = 0; i < 60; i++) await writeAgentRecord(backend, agent, { ...bearerFixture({ session: agent, shareId: `b${String(i).padStart(2, "0")}` }).record, surprise: 1 });
    const index = owner(backend);
    const reads = backend.counters.rawReads;
    const report = await index.reconcile();
    expect(backend.counters.rawReads - reads).toBe(50);
    expect(report).toMatchObject({ rejected: { schema: 50 }, deferred: 10 });
  });
});

describe("CACAO times are read from the verified bytes", () => {
  test("reads iat and nbf; refuses trailing bytes and a CACAO without a payload map", () => {
    const siwe = fakeSiwe({ issuer: OWNER_DID, audience: "did:key:z", attenuation: {}, issuedAt: "2026-01-01T00:00:00.000Z", notBefore: "2026-01-02T00:00:00.000Z" });
    expect(cacaoTimes(siwe.authorization)).toEqual({ issuedAt: "2026-01-01T00:00:00.000Z", notBefore: "2026-01-02T00:00:00.000Z" });
    const bytes = fromBase64Url(siwe.authorization);
    expect(() => cacaoTimes(toBase64Url(new Uint8Array([...bytes, 0])))).toThrow("trailing");
    expect(() => cacaoTimes(toBase64Url(encoder.encode("not cbor")))).toThrow();
  });
});

describe("guards the mutation run left uncovered", () => {
  test("share-sdk's own declared-AAD check refuses a foreign wrap even when the SDK would not", async () => {
    const network = new FakeOwnerNetwork();
    network.checksAad = false;
    const agent = newKey();
    const location = { spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}agents/x/s` };
    const stored = await sealAgentRecord({ plaintext: encoder.encode("{}"), ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network });
    const other = await sealAgentRecord({ plaintext: encoder.encode("{}"), ...location, vaultKey: `${location.vaultKey}2`, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network });
    await expect(openAgentRecordAsOwner({ ...stored, wrapOwner: other.wrapOwner }, location, network)).rejects.toMatchObject({ reason: "decrypt" });
    expect(network.unwrapCalls).toBe(0);
  });

  test("known answer: encKey = HKDF(DEK, \"enc|\"+B) opens ct; commit = HMAC(HKDF(DEK, \"commit|\"+B), B)", async () => {
    const network = new FakeOwnerNetwork();
    const agent = newKey();
    const location = { spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}agents/x/s` };
    const stored = await sealAgentRecord({ plaintext: encoder.encode("{\"k\":1}"), ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: network });
    const binding = agentRecordBinding({ ...location, agentDid: agent.did, ownerNetworkId: NETWORK_ID });
    const dek = await network.unwrap(stored.wrapOwner, binding);
    const base = await crypto.subtle.importKey("raw", dek, "HKDF", false, ["deriveBits"]);
    const sub = async (label: string) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array([...encoder.encode(label), ...binding]) }, base, 256));
    const enc = await crypto.subtle.importKey("raw", await sub("enc|"), "AES-GCM", false, ["decrypt"]);
    const ct = fromBase64Url(stored.ct);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ct.subarray(0, 12), additionalData: binding }, enc, ct.subarray(12)));
    expect(new TextDecoder().decode(plain)).toBe("{\"k\":1}");
    const commitKey = await crypto.subtle.importKey("raw", await sub("commit|"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    expect(toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", commitKey, binding)))).toBe(stored.commit);
    expect(toBase64Url(await sub("enc|"))).not.toBe(toBase64Url(await sub("commit|")));
  });

  test("a SIWE Not Before beyond the clock skew, and a link nbf in the future, are rejected", async () => {
    const now = new Date();
    const agent = newKey();
    const siweNbf = bearerFixture({ session: agent, now, siwe: { notBefore: new Date(now.getTime() + 30 * 60_000).toISOString(), expiresAt: new Date(now.getTime() + 2 * 3_600_000).toISOString() } });
    expect((await verifyAgentRecordChain(siweNbf.record, { accountOwnerDid: OWNER_DID, agentDid: agent.did, now, parseSiweCacao: fakeSiweParser })).ok).toBe(false);
    const leafNbf = bearerFixture({ session: agent, now, link: { nbf: Math.floor(now.getTime() / 1000) + 3600, exp: Math.floor(now.getTime() / 1000) + 7200 } });
    expect((await verifyAgentRecordChain(leafNbf.record, { accountOwnerDid: OWNER_DID, agentDid: agent.did, now, parseSiweCacao: fakeSiweParser })).ok).toBe(false);
  });

  test("a UCAN whose header JWK is another key is refused even when the signature verifies", () => {
    const issuer = newKey();
    const ucan = signUcan(issuer, { aud: newKey().did, att: { r: { "tinycloud.kv/get": [{}] } }, exp: 2_000_000_000 }, { jwkOf: newKey() });
    expect(() => parseSignedUcan(ucan)).toThrow("JWK");
  });

  test("a paused agent's new keys are not fetched", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    for (let i = 0; i < 100; i++) backend.putRawBytes(`agents/${agentIdFromDid(agent.did)}/j${i}/x`, encoder.encode("{}"));
    const index = owner(backend);
    await index.reconcile();
    expect((await doc(index)).agents[agentIdFromDid(agent.did)]!.paused).not.toBe(false);
    await writeAgentRecord(backend, agent, bearerFixture({ session: agent, shareId: "later" }).record);
    const reads = backend.counters.rawReads;
    await index.reconcile();
    expect(backend.counters.rawReads).toBe(reads);
  });

  test("a chained claim on a CID held by an archived row is rejected `proof`", async () => {
    const backend = new MemoryBackend();
    const fixture = bearerFixture();
    const archivedRow: ShareIndexRow = { ...project(fixture.record, { key: "oldweb", src: "web" }) };
    await backend.writeVault("_index/archive-2025", { v: 1, rows: { oldweb: archivedRow } });
    const index = owner(backend);
    await index.reconcile();
    const seeded = await doc(index);
    await backend.writeVault(INDEX_MAIN_KEY, { ...seeded, archives: [{ name: "archive-2025", ids: ["oldweb"] }] });
    const copier = newKey();
    await writeAgentRecord(backend, copier, fixture.record);
    expect((await index.reconcile()).rejected).toEqual({ proof: 1 });
  });

  test("rows mask email audiences", () => {
    const row = project({ ...bearerFixture().record, recipientMatcher: { kind: "exactEmail", value: "alice.smith@example.com" } }, { key: "k", src: "web" });
    expect(row.al).toBe("a…@example.com");
    expect(JSON.stringify(row)).not.toContain("alice.smith");
  });

  test("the agent store lists with the explicit prefix and its trailing slash", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const prefixes: string[] = [];
    const listKeys = backend.listKeys.bind(backend);
    backend.listKeys = async (prefix, cursor) => { prefixes.push(prefix); return listKeys(prefix, cursor); };
    await new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey: await deriveAgentKeyMaterial(agent.privateKey, agent.did) }).list();
    expect(prefixes).toEqual([`agents/${agentIdFromDid(agent.did)}/`]);
  });

  test("Policy/v3 on a real envelope: proven for the policy owner, chained for another agent, unproven without the CACAO", async () => {
    const v3 = v3Fixture.v3;
    const envelope = v3.envelope as unknown as { policy: { ownerDid: string }; attestedEnforcerBinding: { issuedAt: string } };
    const now = new Date(v3Fixture.generatedAt);
    const space = v3.target.spaceId;
    const siwe = fakeSiwe({
      issuer: v3Fixture.ownerDid, audience: envelope.policy.ownerDid, expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      attenuation: { [`${space}/kv`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/metadata": [{}] }, [`urn:tinycloud:encryption:${v3Fixture.ownerDid}:default`]: { "tinycloud.encryption/decrypt": [{}] } },
    });
    const record = {
      shareId: v3.shareId, target: v3.target, resource: v3.resource, actions: ["tinycloud.kv/get"], recipientMatcher: v3.recipientMatcher, targetKind: "recipientDid",
      registeredAt: v3.registeredAt, expiresAt: v3.expiresAt, policyCid: v3.policyCid, ownerDelegationCid: v3.policyRootCid, enforcementDelegationCid: v3.enforcementRootCid,
      deliveryMaterial: await sealDeliveryMaterial(v3.envelope), proofs: { session: siwe.authorization },
    } as unknown as StoredShareRecord;
    const context = (agentDid: string) => ({ accountOwnerDid: v3Fixture.ownerDid, agentDid, now, parseSiweCacao: fakeSiweParser });
    expect(await verifyAgentRecordChain(record, context(v3Fixture.agentDid))).toMatchObject({ ok: true, state: "proven" });
    expect(await verifyAgentRecordChain(record, context(newKey().did))).toMatchObject({ ok: true, state: "chained" });
    expect(await verifyAgentRecordChain({ ...record, proofs: {} }, context(v3Fixture.agentDid))).toMatchObject({ ok: true, state: "unproven" });
    // The node-signed enforcer binding anchors registeredAt.
    const issuedAt = Date.parse(envelope.attestedEnforcerBinding.issuedAt);
    expect(await verifyAgentRecordChain(record, context(v3Fixture.agentDid))).toMatchObject({ issued: { earliest: issuedAt - DAY, latest: issuedAt + DAY } });
  });

  test("verifyEnvelopeV3At judges the enforcer binding at the given time and still refuses a tampered envelope", async () => {
    const envelope = v3Fixture.v3.envelope as unknown as ShareEnvelopeV3;
    const binding = (v3Fixture.v3.envelope as unknown as { attestedEnforcerBinding: { issuedAt: string; expiresAt: string } }).attestedEnforcerBinding;
    const owner = v3Fixture.agentDid;
    expect(await verifyEnvelopeV3At(envelope, owner, Date.parse(binding.issuedAt))).toBe(true);
    expect(await verifyEnvelopeV3At(envelope, owner, Date.parse(binding.expiresAt))).toBe(false);
    expect(await verifyEnvelopeV3At(envelope, newKey().did, Date.parse(binding.issuedAt))).toBe(false);
    const tampered = structuredClone(v3Fixture.v3.envelope) as unknown as { policy: { createdAt: string } };
    tampered.policy.createdAt = "2020-01-01T00:00:00Z";
    expect(await verifyEnvelopeV3At(tampered as unknown as ShareEnvelopeV3, owner, Date.parse(binding.issuedAt))).toBe(false);
  });

  test("the TinyCloud adapter reports a 400 as a refused ETag only for an ifMatch write", async () => {
    const failure = { ok: false as const, error: { code: "KV_WRITE_FAILED", message: "bad request", meta: { status: 400 } } };
    const client: TinyCloudShareIndexClient = {
      vault: { readNetworkEncrypted: async () => ({ status: "not_found" }), put: async () => failure, delete: async () => failure },
      kv: { get: async () => failure, put: async () => failure, list: async () => failure },
      encryption: { encryptToNetwork: async () => failure },
    };
    const backend = createTinyCloudShareIndexBackend({ client, spaceId: SPACE_ID, ownerNetworkId: NETWORK_ID });
    expect(await backend.writeVault("k", {}, { ifMatch: "\"blake3-1\"" })).toMatchObject({ ok: false, code: "invalid_etag" });
    expect(await backend.writeVault("k", {}, { ifNoneMatch: "*" })).toEqual({ ok: false, code: "failed" });
    expect(await backend.writeVault("k", {})).toEqual({ ok: false, code: "failed" });
    expect(await backend.writeRaw("k", {}, { ifNoneMatch: "*" })).toEqual({ ok: false, code: "failed" });
  });
});

// Keep the stored-record type referenced for the helpers above.
export type { StoredAgentRecord };
