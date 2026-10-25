import { describe, expect, test } from "bun:test";
import type { SenderShareRecord } from "../../src/history.js";
import { deriveAgentKeyMaterial } from "../../src/share-index/agent-key.js";
import { agentRecordBinding, MAX_AGENT_RECORD_BYTES, sealAgentRecord, type StoredAgentRecord } from "../../src/share-index/agent-record.js";
import { agentIdFromDid, agentRecordKey, INDEX_MAIN_KEY, SHARE_RECORDS_VAULT_PREFIX } from "../../src/share-index/ids.js";
import { project, type ShareIndexDocument } from "../../src/share-index/schema.js";
import { headerBytes, MemoryShareIndexOutbox, SenderShareIndex, type ShareIndexLimits } from "../../src/share-index/sender-share-index.js";
import { bearerFixture, fakeSiweParser, MemoryBackend, NETWORK_ID, newKey, OWNER_DID, SHARE_ORIGIN, SPACE_ID, standardBase64, type TestKey } from "./helpers.js";

const encoder = new TextEncoder();

function owner(backend: MemoryBackend, limits: Partial<ShareIndexLimits> = {}) {
  return new SenderShareIndex({ backend, outbox: new MemoryShareIndexOutbox(), ownerDid: OWNER_DID, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser, limits, cas: { sleep: async () => {} } });
}

async function writeAgentRecord(backend: MemoryBackend, agent: TestKey, record: SenderShareRecord | Record<string, unknown>, options: { readonly recordV?: number; readonly mutate?: (stored: StoredAgentRecord) => unknown; readonly shareId?: string; readonly underAgent?: string } = {}): Promise<string> {
  const shareId = options.shareId ?? String(record.shareId);
  const agentId = options.underAgent ?? agentIdFromDid(agent.did);
  const key = agentRecordKey(agentId, shareId);
  const agentKey = await deriveAgentKeyMaterial(agent.privateKey, agent.did);
  const stored = await sealAgentRecord({ plaintext: encoder.encode(JSON.stringify(record)), spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}`, agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: backend.network, agentKey, ...(options.recordV === undefined ? {} : { recordV: options.recordV }) });
  const value = options.mutate === undefined ? stored : options.mutate(stored);
  if (value instanceof Uint8Array) backend.putRawBytes(key, value);
  else await backend.writeRaw(key, value as Record<string, unknown>, { ifNoneMatch: "*" });
  return key;
}

async function doc(index: SenderShareIndex): Promise<ShareIndexDocument> {
  const loaded = await index.load();
  if (loaded.status !== "ok") throw new Error(`index is ${loaded.status}`);
  return loaded.doc;
}

async function webRecord(backend: MemoryBackend, shareId: string, extra: Partial<SenderShareRecord> = {}): Promise<SenderShareRecord> {
  const record: SenderShareRecord = {
    shareId, target: { origin: "https://node.test", nodeAudience: "did:key:z6MkNode", spaceId: SPACE_ID }, resource: { kind: "exact", path: `shares/${shareId}/doc.txt` },
    actions: ["tinycloud.kv/get"], recipientMatcher: { kind: "exactEmail", value: "alice@example.com" }, registeredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), filename: "doc.txt", link: `${SHARE_ORIGIN}/s/lqdw5iopqq2tkkvjj6gbbi5vbv#v=4&k=${"A".repeat(43)}&c=bafkreiewixmt5nwgi3ych6durcsheaql3ybswbplpjmpbdhfkvdkidzt5u`, ...extra,
  };
  await backend.writeVault(shareId, record);
  return record;
}

describe("reconciler: an admitted agent record", () => {
  test("is projected display-only and tagged with its proof state; nothing secret reaches the index", async () => {
    const backend = new MemoryBackend();
    const fixture = bearerFixture();
    const key = await writeAgentRecord(backend, fixture.session, fixture.record);
    const index = owner(backend);
    const report = await index.reconcile();
    expect(report).toMatchObject({ status: "written", admitted: 1, cycleComplete: true });
    const row = (await doc(index)).rows[key]!;
    expect(row).toMatchObject({ src: `agent:${agentIdFromDid(fixture.session.did)}`, ps: "proven", cid: fixture.linkCid, rk: "delegation" });
    const text = JSON.stringify(backend.store.get(INDEX_MAIN_KEY)!.value);
    for (const secret of ["tc1", "#k=", "opaque-token", "\"link\":", "deliveryMaterial", "proofs"]) expect(text).not.toContain(secret);
    // Admitted keys are not fetched again.
    const reads = backend.counters.rawReads;
    await index.reconcile();
    expect(backend.counters.rawReads).toBe(reads);
  });
});

describe("reconciler: every §5 check rejects, counts once, and is not refetched (test 5)", () => {
  const agent = newKey();
  const valid = () => bearerFixture({ session: agent }).record;
  const victim = newKey();
  const cases: [string, string, (backend: MemoryBackend) => Promise<unknown>][] = [
    ["shape", "..%2F..%2F_index/main", async (backend) => backend.putRawBytes(`agents/${agentIdFromDid(agent.did)}/..%2F..%2F_index/main`, encoder.encode("{}"))],
    ["shape", "//", async (backend) => backend.putRawBytes(`agents/${agentIdFromDid(agent.did)}//vault/x`, encoder.encode("{}"))],
    ["size", "over 32 KiB", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "big" }, { mutate: (stored) => ({ ...stored, pad: "x".repeat(33 * 1024) }) })],
    // The record is filed under another agent's prefix: that prefix's agent is charged.
    ["header", "agentDid not derived to the path", (backend) => writeAgentRecord(backend, agent, valid(), { underAgent: agentIdFromDid(victim.did), shareId: "s1" })],
    ["header", "another owner network", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "net" }, { mutate: (stored) => ({ ...stored, hdr: { ...stored.hdr, ownerNetworkId: "urn:tinycloud:encryption:other" } }) })],
    ["decrypt", "crafted wrapOwner around a foreign wrapped key", async (backend) => {
      const foreign = await sealAgentRecord({ plaintext: encoder.encode("{}"), spaceId: SPACE_ID, vaultKey: "elsewhere", agentDid: agent.did, ownerNetworkId: NETWORK_ID, ownerWrap: backend.network });
      const key = agentRecordKey(agentIdFromDid(agent.did), "crafted");
      const binding = agentRecordBinding({ spaceId: SPACE_ID, vaultKey: `${SHARE_RECORDS_VAULT_PREFIX}${key}`, agentDid: agent.did, ownerNetworkId: NETWORK_ID });
      return writeAgentRecord(backend, agent, { ...valid(), shareId: "crafted" }, { mutate: (stored) => ({ ...stored, wrapOwner: { ...foreign.wrapOwner, aad: standardBase64(binding) } }) });
    }],
    ["decrypt", "bad commit", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "commit" }, { mutate: (stored) => ({ ...stored, commit: stored.commit.replace(/^./, (c) => (c === "A" ? "B" : "A")) }) })],
    ["schema", "unknown field at a known recordV", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "unk", surprise: 1 })],
    ["schema", "shareId ≠ key basename", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "other" }, { shareId: "basename" })],
    ["schema", "another space", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "space", target: { origin: "https://node.test", nodeAudience: "did:key:z", spaceId: "tinycloud:other" } })],
    ["schema", "registeredAt 3 days off the link's signed nbf", (backend) => writeAgentRecord(backend, agent, { ...bearerFixture({ session: agent, link: { nbf: Math.floor(Date.now() / 1000) - 60 } }).record, shareId: "old", registeredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })],
    ["schema", "an action outside the share actions", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "act", actions: ["tinycloud.kv/del"] })],
    ["schema", "a resource outside the share prefixes", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "res", resource: { kind: "exact", path: "secrets/x" } })],
    ["schema", "a foreign ownerDid", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "own", ownerDid: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" })],
    ["link", "a foreign origin", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "lnk", link: "https://evil.test/viewer#tc1=x" })],
    ["link", "javascript:", (backend) => writeAgentRecord(backend, agent, { ...valid(), shareId: "js", link: "javascript:alert(1)" })],
    ["proof", "a SIWE not signed by the owner", async (backend) => { const f = bearerFixture({ session: agent, siwe: { issuer: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" } }); return writeAgentRecord(backend, agent, f.record); }],
  ];

  for (const [reason, name, write] of cases) {
    test(`${reason}: ${name}`, async () => {
      const backend = new MemoryBackend();
      const web = await webRecord(backend, "web1");
      const index = owner(backend);
      await index.reconcile();
      const webRowBefore = (await doc(index)).rows.web1;
      await write(backend);
      const report = await index.reconcile();
      expect(report.rejected).toEqual({ [reason]: 1 });
      const charged = name === "agentDid not derived to the path" ? victim : agent;
      const entry = (await doc(index)).agents[agentIdFromDid(charged.did)]!;
      expect(entry.rejected).toEqual({ [reason]: 1 });
      expect(entry.rejectedKeys.length).toBe(1);
      expect((await doc(index)).rows.web1).toEqual(webRowBefore);
      expect(webRowBefore).toEqual(project(web, { key: "web1", src: "web" }));
      const reads = backend.counters.rawReads;
      const second = await index.reconcile();
      expect(second.rejected).toEqual({});
      expect(backend.counters.rawReads).toBe(reads);
      expect((await doc(index)).agents[agentIdFromDid(charged.did)]!.rejected).toEqual({ [reason]: 1 });
    });
  }

  test("a newer recordV is skipped as newer, not rejected, and not refetched", async () => {
    const backend = new MemoryBackend();
    await writeAgentRecord(backend, agent, valid(), { recordV: 2 });
    const index = owner(backend);
    expect((await index.reconcile()).rejected).toEqual({});
    const entry = (await doc(index)).agents[agentIdFromDid(agent.did)]!;
    expect(entry.rejected).toEqual({});
    expect(entry.newerKeys?.length).toBe(1);
    const reads = backend.counters.rawReads;
    await index.reconcile();
    expect(backend.counters.rawReads).toBe(reads);
  });

  test("a decrypt outage is not a verdict: the record is retried on the next pass", async () => {
    const backend = new MemoryBackend();
    const fixture = bearerFixture({ session: agent });
    await writeAgentRecord(backend, agent, fixture.record);
    backend.network.unavailable = true;
    const index = owner(backend);
    expect((await index.reconcile()).admitted).toBe(0);
    backend.network.unavailable = false;
    expect((await index.reconcile()).admitted).toBe(1);
  });
});

describe("reconciler: R3 flood, V3-1 and V3-8 (test 6)", () => {
  test("20k junk keys and 600 valid rows: paused with ≤100 rejectedKeys, header ≤64 KiB, no web row lost, budget held", async () => {
    const backend = new MemoryBackend();
    await webRecord(backend, "web1");
    const flooder = newKey();
    const agentId = agentIdFromDid(flooder.did);
    for (let i = 0; i < 600; i++) {
      const fixture = bearerFixture({ session: flooder, shareId: `v${String(i).padStart(4, "0")}` });
      await writeAgentRecord(backend, flooder, fixture.record);
    }
    for (let i = 0; i < 20_000; i++) backend.putRawBytes(`agents/${agentId}/junk${String(i).padStart(5, "0")}/x`, encoder.encode("{}"));
    const index = owner(backend);
    const lists = backend.counters.lists;
    for (let pass = 0; pass < 6; pass++) {
      const report = await index.reconcile();
      expect(report.pages).toBeLessThanOrEqual(10);
      expect(report.fetches).toBeLessThanOrEqual(200);
    }
    expect(backend.counters.lists - lists).toBeLessThanOrEqual(60);
    const final = await doc(index);
    const entry = final.agents[agentId]!;
    expect(entry.paused).not.toBe(false);
    expect(entry.rejectedKeys.length).toBeLessThanOrEqual(100);
    expect(headerBytes(final)).toBeLessThanOrEqual(64 * 1024);
    expect(final.rows.web1).toBeDefined();
    expect(final.archives).toEqual([]);
  });

  test("valid rows are admitted ≤50 per agent per pass and capped at 500 live rows, then the agent pauses", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    for (let i = 0; i < 520; i++) await writeAgentRecord(backend, agent, bearerFixture({ session: agent, shareId: `v${String(i).padStart(4, "0")}` }).record);
    const index = owner(backend, { fetchesPerPass: 1000 });
    const first = await index.reconcile();
    expect(first.admitted).toBe(50);
    for (let pass = 0; pass < 12; pass++) await index.reconcile();
    const entry = (await doc(index)).agents[agentIdFromDid(agent.did)]!;
    expect(entry.rows).toBe(500);
    expect(entry.paused).toMatchObject({ reason: "row-cap" });
  });

  test("(V3-1) a valid key that sorts below an earlier rejected key is admitted", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    await writeAgentRecord(backend, agent, { ...bearerFixture({ session: agent }).record, shareId: "f-bad", surprise: true });
    const index = owner(backend);
    await index.reconcile();
    const good = bearerFixture({ session: agent, shareId: "3-good" });
    const key = await writeAgentRecord(backend, agent, good.record);
    expect((await index.reconcile()).admitted).toBe(1);
    expect((await doc(index)).rows[key]).toBeDefined();
  });

  test("(V3-8) an agent whose prefix is emptied loses its header entry", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const key = await writeAgentRecord(backend, agent, { ...bearerFixture({ session: agent }).record, surprise: true });
    const index = owner(backend);
    await index.reconcile();
    expect((await doc(index)).agents[agentIdFromDid(agent.did)]).toBeDefined();
    backend.store.delete(key);
    await index.reconcile();
    expect((await doc(index)).agents[agentIdFromDid(agent.did)]).toBeUndefined();
  });
});

describe("reconciler: precedence across passes (test 8, C3)", () => {
  test("a copied proof admitted first as chained is displaced by the genuine proven record a pass later", async () => {
    const backend = new MemoryBackend();
    const genuine = newKey();
    const copier = newKey();
    const fixture = bearerFixture({ session: genuine });
    const copiedKey = await writeAgentRecord(backend, copier, fixture.record);
    const index = owner(backend);
    await index.reconcile();
    expect((await doc(index)).rows[copiedKey]).toMatchObject({ ps: "chained" });
    const genuineKey = await writeAgentRecord(backend, genuine, fixture.record);
    await index.reconcile();
    const final = await doc(index);
    expect(final.rows[genuineKey]).toMatchObject({ ps: "proven" });
    expect(final.rows[copiedKey]).toBeUndefined();
    expect(final.agents[agentIdFromDid(copier.did)]).toMatchObject({ rows: 0, rejected: { proof: 1 } });
    // The displaced copy is not refetched.
    const reads = backend.counters.rawReads;
    await index.reconcile();
    expect(backend.counters.rawReads).toBe(reads);
  });

  test("a web share's CID in an agent row ends chained at best, and the web row wins whichever comes first", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const fixture = bearerFixture({ session: newKey() });
    const agentKey = await writeAgentRecord(backend, agent, fixture.record);
    const index = owner(backend);
    await index.reconcile();
    expect((await doc(index)).rows[agentKey]).toMatchObject({ ps: "chained" });
    await webRecord(backend, "webshare", { enforcementDelegationCid: fixture.linkCid, targetKind: "bearer" });
    await index.reconcile();
    const final = await doc(index);
    expect(final.rows.webshare).toBeDefined();
    expect(final.rows[agentKey]).toBeUndefined();
    // And the web row admitted first refuses the later agent claim.
    const later = await writeAgentRecord(backend, newKey(), fixture.record);
    await index.reconcile();
    expect((await doc(index)).rows[later]).toBeUndefined();
  });

  test("chained displaces unproven; unproven never displaces anything", async () => {
    const backend = new MemoryBackend();
    const issuer = newKey();
    const withSession = bearerFixture({ session: issuer });
    const withoutSession = { ...withSession.record, proofs: { link: withSession.record.proofs!.link! } };
    const unprovenKey = await writeAgentRecord(backend, issuer, withoutSession);
    const index = owner(backend);
    await index.reconcile();
    expect((await doc(index)).rows[unprovenKey]).toMatchObject({ ps: "unproven" });
    const chainedKey = await writeAgentRecord(backend, newKey(), withSession.record);
    await index.reconcile();
    expect((await doc(index)).rows[chainedKey]).toMatchObject({ ps: "chained" });
    expect((await doc(index)).rows[unprovenKey]).toBeUndefined();
    const lateUnproven = await writeAgentRecord(backend, newKey(), withoutSession);
    await index.reconcile();
    expect((await doc(index)).rows[lateUnproven]).toBeUndefined();
    expect((await doc(index)).rows[chainedKey]).toBeDefined();
  });
});

describe("repair and rebuild (test 9)", () => {
  test("status sync confirms a dropped revoke and clears a forged unconfirmed one; unknown changes nothing", async () => {
    const backend = new MemoryBackend();
    await webRecord(backend, "dropped", { enforcementDelegationCid: "bafkreidropped" });
    await webRecord(backend, "forged", { enforcementDelegationCid: "bafkreiforged", revokedAt: "2026-01-01T00:00:00.000Z" });
    await webRecord(backend, "unknown", { enforcementDelegationCid: "bafkreiunknown", revokedAt: "2026-01-01T00:00:00.000Z" });
    const index = owner(backend);
    await index.reconcile();
    const status = { dropped: "revoked", forged: "active", unknown: "unknown" } as const;
    await index.syncStatus({ status: async (key) => status[key as keyof typeof status] });
    const rows = (await doc(index)).rows;
    expect(rows.dropped!.r).toMatchObject({ confirmed: true });
    expect(rows.forged!.r).toBeUndefined();
    expect(rows.unknown!.r).toEqual({ at: "2026-01-01T00:00:00.000Z", confirmed: false });
    // Confirmed revocation is sticky.
    await index.syncStatus({ status: async () => "active" });
    expect((await doc(index)).rows.dropped!.r).toMatchObject({ confirmed: true });
  });

  test("archived rows are not re-added, tombstoned keys are not refetched, and delete is refused on live rows", async () => {
    const backend = new MemoryBackend();
    for (let i = 0; i < 30; i++) await webRecord(backend, `w${i}`, { registeredAt: new Date(Date.now() - (40 - i) * 1000).toISOString() });
    const index = owner(backend, { mainRowBytes: 3000 });
    await index.reconcile();
    const compacted = await index.compact();
    expect(compacted.archived).toBeGreaterThan(0);
    const archivedDoc = await doc(index);
    expect(Object.keys(archivedDoc.rows).length).toBe(30 - compacted.archived);
    const archiveName = archivedDoc.archives[0]!.name;
    expect(backend.store.get(`_index/${archiveName}`)).toBeDefined();
    const reads = backend.vaultReadKeys.length;
    await index.reconcile();
    expect(Object.keys((await doc(index)).rows).length).toBe(30 - compacted.archived);
    expect(backend.vaultReadKeys.slice(reads).filter((key) => !key.startsWith("_index/"))).toEqual([]);
    const live = Object.keys((await doc(index)).rows)[0]!;
    await index.enqueue({ id: "d1", type: "delete", key: live });
    expect((await index.flush()).refused).toEqual(["d1"]);
    await index.enqueue({ id: "r1", type: "revoke", key: live, at: new Date().toISOString(), confirmed: true });
    await index.enqueue({ id: "d2", type: "delete", key: live });
    expect((await index.flush()).refused).toEqual([]);
    expect((await doc(index)).tombstones.map((item) => item.key)).toContain(live);
    await index.enqueue({ id: "u1", type: "upsert", key: live, row: project((await backend.readVault(live) as { value: SenderShareRecord }).value, { key: live, src: "web" }) });
    expect((await index.flush()).refused).toEqual(["u1"]);
  });

  test("deterministic corruption rebuilds (rediscovering archives); an outage never rebuilds", async () => {
    const backend = new MemoryBackend();
    await webRecord(backend, "w1");
    await backend.writeVault("_index/archive-2025", { v: 1, rows: { old: { n: "o", k: "file", ak: "bearer", al: "", a: [], c: "2025-01-01T00:00:00.000Z", x: "2025-02-01T00:00:00.000Z", rk: "none", src: "web" } } });
    backend.putRawBytes(INDEX_MAIN_KEY, encoder.encode("garbage"));
    const index = owner(backend);
    expect((await index.load()).status).toBe("corrupt");
    await index.reconcile();
    const rebuilt = await doc(index);
    expect(rebuilt.archives).toEqual([{ name: "archive-2025", ids: ["old"] }]);
    expect(rebuilt.rows.w1).toBeDefined();
    const outage = Object.assign(Object.create(backend) as MemoryBackend, { readVault: async () => ({ status: "unavailable" as const }) });
    const before = backend.store.get(INDEX_MAIN_KEY);
    const offline = owner(outage);
    await offline.enqueue({ id: "x", type: "revoke", key: "w1", at: new Date().toISOString(), confirmed: false });
    expect((await offline.flush()).status).toBe("unavailable");
    expect(backend.store.get(INDEX_MAIN_KEY)).toBe(before);
  });

  test("an old client meeting v+1 writes nothing; unknown fields round-trip", async () => {
    const backend = new MemoryBackend();
    const index = owner(backend);
    await webRecord(backend, "w1");
    await index.reconcile();
    const current = (await doc(index)) as unknown as Record<string, unknown>;
    await backend.writeVault(INDEX_MAIN_KEY, { ...current, futureHeader: { keep: true }, rows: { ...(current.rows as object), w1: { ...(current.rows as Record<string, object>).w1, futureRow: 1 } } });
    await webRecord(backend, "w2");
    await index.reconcile();
    const roundTripped = (await doc(index)) as unknown as Record<string, unknown>;
    expect(roundTripped.futureHeader).toEqual({ keep: true });
    expect((roundTripped.rows as Record<string, Record<string, unknown>>).w1!.futureRow).toBe(1);
    await backend.writeVault(INDEX_MAIN_KEY, { ...roundTripped, v: 2 });
    const writes = backend.counters.writes;
    expect((await index.load()).status).toBe("read_only");
    await index.enqueue({ id: "x", type: "revoke", key: "w1", at: new Date().toISOString(), confirmed: false });
    expect((await index.flush()).status).toBe("read_only");
    expect((await index.reconcile()).status).toBe("read_only");
    expect(backend.counters.writes).toBe(writes);
  });

  test("crash after enqueue or after the record write: a fresh instance on the same outbox converges to one row", async () => {
    const backend = new MemoryBackend();
    const outbox = new MemoryShareIndexOutbox();
    const make = () => new SenderShareIndex({ backend, outbox, ownerDid: OWNER_DID, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser, cas: { sleep: async () => {} } });
    const record = await webRecord(backend, "crash1");
    await make().enqueue({ id: "op", type: "upsert", key: "crash1", row: project(record, { key: "crash1", src: "web" }) });
    // The first instance dies here. A new one replays the outbox, and the reconciler agrees.
    const fresh = make();
    expect((await fresh.flush()).status).toBe("written");
    await fresh.reconcile();
    expect(Object.keys((await doc(fresh)).rows)).toEqual(["crash1"]);
    expect(await outbox.list()).toEqual([]);
  });
});

describe("the agent-record size cap at the reconciler (TC-1432 ruling: 32 KiB)", () => {
  test("a stored record of exactly MAX_AGENT_RECORD_BYTES is admitted; one byte more is rejected `size`", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const padTo = (bytes: number) => (stored: StoredAgentRecord) => {
      const base = encoder.encode(JSON.stringify({ ...stored, wrapOwner: { ...stored.wrapOwner, pad: "" } })).length;
      return { ...stored, wrapOwner: { ...stored.wrapOwner, pad: "x".repeat(bytes - base) } };
    };
    const atCap = await writeAgentRecord(backend, agent, bearerFixture({ session: agent, shareId: "atcap" }).record, { mutate: padTo(MAX_AGENT_RECORD_BYTES) });
    const overCap = await writeAgentRecord(backend, agent, bearerFixture({ session: agent, shareId: "overcap" }).record, { mutate: padTo(MAX_AGENT_RECORD_BYTES + 1) });
    expect((await backend.readRaw(atCap) as { bytes: Uint8Array }).bytes.length).toBe(MAX_AGENT_RECORD_BYTES);
    expect((await backend.readRaw(overCap) as { bytes: Uint8Array }).bytes.length).toBe(MAX_AGENT_RECORD_BYTES + 1);
    const index = owner(backend);
    const report = await index.reconcile();
    expect(report).toMatchObject({ admitted: 1, rejected: { size: 1 } });
    expect((await doc(index)).rows[atCap]).toMatchObject({ ps: "proven" });
    expect((await doc(index)).rows[overCap]).toBeUndefined();
  });
});

describe("migrated provenance: a one-time owner import path (TC-1432 ruling)", () => {
  const old = () => new Date(Date.now() - 200 * 86_400_000).toISOString();
  const migrated = (fixture: ReturnType<typeof bearerFixture>, extra: Partial<SenderShareRecord> = {}): SenderShareRecord => ({ ...fixture.record, registeredAt: old(), provenance: "migrated", ...extra });

  test("an agent-subtree record claiming `migrated` is rejected and counted, never admitted, not refetched", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const key = await writeAgentRecord(backend, agent, { ...bearerFixture({ session: agent }).record, provenance: "migrated" });
    const index = owner(backend);
    expect((await index.reconcile()).rejected).toEqual({ provenance: 1 });
    const final = await doc(index);
    expect(final.rows[key]).toBeUndefined();
    expect(final.agents[agentIdFromDid(agent.did)]).toMatchObject({ rows: 0, rejected: { provenance: 1 } });
    const reads = backend.counters.rawReads;
    await index.reconcile();
    expect(backend.counters.rawReads).toBe(reads);
  });

  test("an owner-written import is exempt from the first-sight window, ranks by its proof (never `proven`, never web)", async () => {
    const backend = new MemoryBackend();
    const withSession = bearerFixture();
    const withoutSession = bearerFixture();
    await backend.writeVault("imp1", migrated(withSession, { shareId: "imp1" }));
    await backend.writeVault("imp2", migrated(withoutSession, { shareId: "imp2", proofs: { link: withoutSession.record.proofs!.link! } }));
    const index = owner(backend);
    await index.reconcile();
    const rows = (await doc(index)).rows;
    expect(rows.imp1).toMatchObject({ src: "web", pv: "migrated", ps: "chained", cid: withSession.linkCid });
    expect(rows.imp2).toMatchObject({ src: "web", pv: "migrated", ps: "unproven" });
    expect(rows.imp1!.na).toBeUndefined();
  });

  test("nothing else is relaxed: a bad link, a foreign action or a failed chain leaves only a claimless needs-attention row", async () => {
    const backend = new MemoryBackend();
    const cases: [string, SenderShareRecord][] = [
      ["link", migrated(bearerFixture(), { shareId: "badlink", link: "https://evil.test/viewer#tc1=x" })],
      ["action", migrated(bearerFixture(), { shareId: "badaction", actions: ["tinycloud.kv/del" as never] })],
      ["proof", migrated(bearerFixture({ siwe: { issuer: "did:pkh:eip155:1:0x1111111111111111111111111111111111111111" } }), { shareId: "badproof" })],
      ["future", migrated(bearerFixture(), { shareId: "future", registeredAt: new Date(Date.now() + 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })],
    ];
    for (const [, record] of cases) await backend.writeVault(record.shareId, record);
    const index = owner(backend);
    await index.reconcile();
    const rows = (await doc(index)).rows;
    for (const [name, record] of cases) {
      expect({ name, row: rows[record.shareId] }).toMatchObject({ name, row: { na: true, pv: "migrated" } });
      expect(rows[record.shareId]!.cc).toBeUndefined();
    }
  });

  test("`migrated` cannot override precedence: a proven agent row keeps the CID, and a web row displaces an import", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const fixture = bearerFixture({ session: agent });
    const agentKey = await writeAgentRecord(backend, agent, fixture.record);
    const index = owner(backend);
    await index.reconcile();
    await backend.writeVault("imp", migrated(fixture, { shareId: "imp" }));
    await index.reconcile();
    let rows = (await doc(index)).rows;
    expect(rows[agentKey]).toMatchObject({ ps: "proven", cid: fixture.linkCid });
    expect(rows.imp).toMatchObject({ pv: "migrated", na: true });
    expect(rows.imp!.cc).toBeUndefined();
    // An import that holds a CID is displaced by a later web record for it.
    const other = bearerFixture();
    await backend.writeVault("imp2", migrated(other, { shareId: "imp2" }));
    await index.reconcile();
    await webRecord(backend, "webshare", { enforcementDelegationCid: other.linkCid, targetKind: "bearer" });
    await index.reconcile();
    rows = (await doc(index)).rows;
    expect(rows.webshare).toBeDefined();
    expect(rows.imp2).toBeUndefined();
  });

  test("`migrated` cannot override a node-confirmed revocation, even when it would outrank the row", async () => {
    const backend = new MemoryBackend();
    const issuer = newKey();
    const fixture = bearerFixture({ session: issuer });
    const unproven = { ...fixture.record, proofs: { link: fixture.record.proofs!.link! } };
    const agentKey = await writeAgentRecord(backend, issuer, unproven);
    const index = owner(backend);
    await index.reconcile();
    await index.enqueue({ id: "rv", type: "revoke", key: agentKey, at: new Date().toISOString(), confirmed: true });
    await index.flush();
    await backend.writeVault("imp", migrated(fixture, { shareId: "imp" }));
    await index.reconcile();
    const rows = (await doc(index)).rows;
    expect(rows[agentKey]).toMatchObject({ ps: "unproven", r: { confirmed: true } });
    expect(rows.imp).toMatchObject({ pv: "migrated", na: true });
    expect(rows.imp!.cc).toBeUndefined();
  });
});
