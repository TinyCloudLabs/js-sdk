import { describe, expect, test } from "bun:test";
import { createTinyCloudShareIndexBackend, type TinyCloudShareIndexClient } from "../../src/share-index/backend.js";
import { ShareIndexCasError } from "../../src/share-index/cas.js";
import { INDEX_MAIN_KEY } from "../../src/share-index/ids.js";
import type { ShareIndexRow } from "../../src/share-index/schema.js";
import { MemoryShareIndexOutbox, SenderShareIndex } from "../../src/share-index/sender-share-index.js";
import { fakeSiweParser, MemoryBackend, NETWORK_ID, OWNER_DID, SHARE_ORIGIN, SPACE_ID } from "./helpers.js";

/** The message slice 1 (#580) gives a weakened ETag; the index passes it through unchanged. */
const SDK_WEAK_ETAG_MESSAGE = "The ETag was weakened in transit (W/\"…\"); compare-and-swap is unavailable through this path.";

const row = (n: string): ShareIndexRow => ({ n, k: "file", ak: "bearer", al: "link", a: ["tinycloud.kv/get"], c: "2026-10-18T00:00:00.000Z", x: "2099-01-01T00:00:00.000Z", rk: "delegation", cid: `cid-${n}`, cc: [`cid-${n}`], src: "web" });

function setup(backend: MemoryBackend = new MemoryBackend()) {
  const sleeps: number[] = [];
  const outbox = new MemoryShareIndexOutbox();
  const index = new SenderShareIndex({
    backend, outbox, ownerDid: OWNER_DID, writer: "test", shareOrigins: [SHARE_ORIGIN], parseSiweCacao: fakeSiweParser,
    cas: { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 },
  });
  return { backend, outbox, index, sleeps };
}

async function seeded() {
  const context = setup();
  await context.index.enqueue({ id: "seed", type: "upsert", key: "seed", row: row("seed") });
  expect((await context.index.flush()).status).toBe("written");
  return context;
}

describe("CAS client: INVALID_ETAG is surfaced, never retried", () => {
  test("the first INVALID_ETAG throws with the SDK's message after exactly one write; nothing is marked clean", async () => {
    const { backend, outbox, index, sleeps } = await seeded();
    const before = backend.store.get(INDEX_MAIN_KEY)!;
    await index.enqueue({ id: "op1", type: "upsert", key: "a", row: row("a") });
    const writes = backend.counters.writes;
    backend.writeHook = () => ({ result: { ok: false, code: "invalid_etag", message: SDK_WEAK_ETAG_MESSAGE } });
    let caught: unknown;
    try { await index.flush(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ShareIndexCasError);
    expect((caught as ShareIndexCasError).code).toBe("INVALID_ETAG");
    expect((caught as ShareIndexCasError).message).toBe(SDK_WEAK_ETAG_MESSAGE);
    expect((caught as ShareIndexCasError).attempts).toBe(1);
    expect(backend.counters.writes - writes).toBe(1);
    expect(sleeps).toEqual([]);
    // The op is still pending and the stored index is untouched.
    expect((await outbox.list()).map((op) => op.id)).toEqual(["op1"]);
    expect(backend.store.get(INDEX_MAIN_KEY)).toEqual(before);
    const loaded = await index.load();
    expect(loaded.status === "ok" && Object.keys(loaded.doc.rows)).toEqual(["seed"]);
    // Once the path stops weakening the ETag, the same op applies once.
    backend.writeHook = undefined;
    expect((await index.flush()).status).toBe("written");
    expect(await outbox.list()).toEqual([]);
  });

  test("the TinyCloud adapter maps the SDK's INVALID_ETAG (and the node's 400) without retrying", async () => {
    for (const error of [{ code: "INVALID_ETAG", message: SDK_WEAK_ETAG_MESSAGE }, { code: "KV_WRITE_FAILED", message: SDK_WEAK_ETAG_MESSAGE, meta: { status: 400 } }]) {
      let puts = 0;
      const stored = { value: { v: 1, ownerDid: OWNER_DID, spaceId: SPACE_ID, updatedAt: "x", updatedBy: "x", archives: [], tombstones: [], reconcile: {}, agents: {}, rows: {} }, etag: "\"blake3-1\"" };
      const client: TinyCloudShareIndexClient = {
        vault: {
          readNetworkEncrypted: async () => ({ status: "ok", entry: structuredClone(stored) }),
          put: async () => { puts++; return { ok: false, error }; },
          delete: async () => ({ ok: true, data: undefined }),
        },
        kv: {
          get: async () => ({ ok: false, error: { code: "KV_NOT_FOUND" } }),
          put: async () => ({ ok: true, data: undefined }),
          list: async () => ({ ok: true, data: { keys: [] } }),
        },
        encryption: { encryptToNetwork: async () => ({ ok: true, data: {} }) },
      };
      const backend = createTinyCloudShareIndexBackend({ client, spaceId: SPACE_ID, ownerNetworkId: NETWORK_ID });
      const outbox = new MemoryShareIndexOutbox();
      const index = new SenderShareIndex({ backend, outbox, ownerDid: OWNER_DID, writer: "t", shareOrigins: [], parseSiweCacao: fakeSiweParser, cas: { sleep: async () => {} } });
      await index.enqueue({ id: "op", type: "upsert", key: "a", row: row("a") });
      await expect(index.flush()).rejects.toMatchObject({ code: "INVALID_ETAG", message: SDK_WEAK_ETAG_MESSAGE });
      expect(puts).toBe(1);
      expect((await outbox.list()).length).toBe(1);
    }
  });
});

describe("CAS client: ETAG_MISMATCH, NODE_BUSY, OUTCOME_UNKNOWN", () => {
  test("ETAG_MISMATCH re-reads and backs off 50 ms·2ⁿ (jittered, ≤1 s), then gives up after 6 attempts", async () => {
    const { backend, index, sleeps, outbox } = await seeded();
    await index.enqueue({ id: "op", type: "upsert", key: "a", row: row("a") });
    const writes = backend.counters.writes;
    backend.writeHook = () => ({ result: { ok: false, code: "conflict" } });
    await expect(index.flush()).rejects.toMatchObject({ code: "EXHAUSTED" });
    expect(backend.counters.writes - writes).toBe(6);
    expect(sleeps).toEqual([37, 75, 150, 300, 600]);
    expect((await outbox.list()).length).toBe(1);
  });

  test("a lost race converges on the next attempt with the winner's change kept", async () => {
    const { backend, index } = await seeded();
    await index.enqueue({ id: "op", type: "upsert", key: "mine", row: row("mine") });
    let raced = false;
    backend.writeHook = () => {
      if (raced) return undefined;
      raced = true;
      // Another writer commits first.
      const current = backend.store.get(INDEX_MAIN_KEY)!;
      const value = structuredClone(current.value) as { rows: Record<string, ShareIndexRow> };
      value.rows.theirs = row("theirs");
      backend.store.set(INDEX_MAIN_KEY, { value, etag: "\"blake3-ff\"", raw: false });
      return { result: { ok: false, code: "conflict" } };
    };
    expect((await index.flush()).status).toBe("written");
    const loaded = await index.load();
    expect(loaded.status === "ok" && Object.keys(loaded.doc.rows).sort()).toEqual(["mine", "seed", "theirs"]);
  });

  test("NODE_BUSY backs off and retries", async () => {
    const { backend, index, sleeps } = await seeded();
    await index.enqueue({ id: "op", type: "upsert", key: "a", row: row("a") });
    let busy = 2;
    backend.writeHook = () => (busy-- > 0 ? { result: { ok: false, code: "busy" } } : undefined);
    expect((await index.flush()).status).toBe("written");
    expect(sleeps.length).toBe(2);
  });

  test("OUTCOME_UNKNOWN is never a blind re-put: re-read, and an applied change is not written again", async () => {
    const { backend, index, outbox, sleeps } = await seeded();
    await index.enqueue({ id: "op", type: "upsert", key: "a", row: row("a") });
    const writes = backend.counters.writes;
    let first = true;
    backend.writeHook = () => {
      if (!first) return undefined;
      first = false;
      return { result: { ok: false, code: "outcome_unknown" }, apply: true };
    };
    expect((await index.flush()).status).toBe("unchanged");
    expect(backend.counters.writes - writes).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await outbox.list()).toEqual([]);
  });

  test("a flush whose ops are already applied does not write", async () => {
    const { backend, index } = await seeded();
    await index.enqueue({ id: "again", type: "upsert", key: "seed", row: row("seed") });
    const writes = backend.counters.writes;
    expect((await index.flush()).status).toBe("unchanged");
    expect(backend.counters.writes).toBe(writes);
    expect((await index.flush()).status).toBe("empty");
  });
});
