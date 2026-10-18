import { describe, expect, test } from "bun:test";
import { deriveAgentKeyMaterial } from "../../src/share-index/agent-key.js";
import { agentIdFromDid, agentRecordKey } from "../../src/share-index/ids.js";
import { AgentShareRecordStore, WebShareRecordStore } from "../../src/share-index/record-store.js";
import { MemoryShareIndexOutbox, SenderShareIndex } from "../../src/share-index/sender-share-index.js";
import { bearerFixture, fakeSiweParser, MemoryBackend, newKey, OWNER_DID, SHARE_ORIGIN, type TestKey } from "./helpers.js";

async function agentStore(backend: MemoryBackend, agent: TestKey) {
  return new AgentShareRecordStore({ backend, agentDid: agent.did, agentKey: await deriveAgentKeyMaterial(agent.privateKey, agent.did), cas: { maxAttempts: 6, backoffBaseMs: 1, backoffCapMs: 1, sleep: async () => {}, random: () => 0 } });
}

describe("space record store (§1, §3)", () => {
  test("web records: isShareId on every call, CAS update, classified list", async () => {
    const backend = new MemoryBackend();
    const store = new WebShareRecordStore(backend);
    const record = bearerFixture({ shareId: "web1" }).record;
    await store.put(record);
    await expect(store.put({ ...record, shareId: "_index" })).rejects.toThrow("share id");
    await expect(store.get("../x")).rejects.toThrow("share id");
    backend.putRawBytes(`agents/${agentIdFromDid(newKey().did)}/x`, new Uint8Array([1]));
    const updated = await store.update("web1", (current) => ({ ...current, revokedAt: "2026-10-18T00:00:00.000Z" }));
    expect(updated?.revokedAt).toBe("2026-10-18T00:00:00.000Z");
    expect((await store.list()).map((item) => item.shareId)).toEqual(["web1"]);
  });

  test("agent records: put/get/update/list on its own prefix; each write draws a fresh seal; no delete", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const store = await agentStore(backend, agent);
    const fixture = bearerFixture({ session: agent, shareId: "s1" });
    await store.put(fixture.record);
    const key = agentRecordKey(store.agentId, "s1");
    const first = structuredClone(backend.store.get(key)!.value) as { ct: string; commit: string };
    const revoked = await store.update("s1", (record) => ({ ...record, revokedAt: "2026-10-18T00:00:00.000Z" }));
    const second = backend.store.get(key)!.value as { ct: string; commit: string };
    expect(second.ct.slice(0, 16)).not.toBe(first.ct.slice(0, 16));
    expect(second.commit).not.toBe(first.commit);
    expect((await store.get("s1"))?.revokedAt).toBe(revoked!.revokedAt!);
    expect((await store.list()).map((record) => record.shareId)).toEqual(["s1"]);
    await expect(store.delete("s1")).rejects.toThrow("owner");
    // A record that would be stored over MAX_AGENT_RECORD_BYTES is refused before it is written.
    const writes = backend.counters.writes;
    await expect(store.put({ ...fixture.record, shareId: "big", filename: "x", deliveryMaterial: { pad: "y".repeat(40_000) } as never })).rejects.toMatchObject({ reason: "size" });
    expect(backend.counters.writes).toBe(writes);
  });

  test("(7f) a lost agent key: the new key gets a new prefix and cannot read the old records, which stay owner-visible and proven", async () => {
    const backend = new MemoryBackend();
    const oldAgent = newKey();
    const newAgent = newKey();
    const oldStore = await agentStore(backend, oldAgent);
    await oldStore.put(bearerFixture({ session: oldAgent, shareId: "old1" }).record);
    const newStore = await agentStore(backend, newAgent);
    expect(newStore.agentId).not.toBe(oldStore.agentId);
    expect(await newStore.list()).toEqual([]);
    const index = new SenderShareIndex({ backend, outbox: new MemoryShareIndexOutbox(), ownerDid: OWNER_DID, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser });
    await index.reconcile();
    const loaded = await index.load();
    expect(loaded.status === "ok" && loaded.doc.rows[agentRecordKey(oldStore.agentId, "old1")]?.ps).toBe("proven");
  });

  test("(7i) a remote-signer-only profile writes owner-readable records it cannot read back", async () => {
    const backend = new MemoryBackend();
    const agent = newKey();
    const store = new AgentShareRecordStore({ backend, agentDid: agent.did });
    expect(store.canReadBack).toBe(false);
    await store.put(bearerFixture({ session: agent, shareId: "r1" }).record);
    await expect(store.get("r1")).rejects.toThrow("cannot read");
    const index = new SenderShareIndex({ backend, outbox: new MemoryShareIndexOutbox(), ownerDid: OWNER_DID, writer: "web", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser });
    expect((await index.reconcile()).admitted).toBe(1);
  });
});
