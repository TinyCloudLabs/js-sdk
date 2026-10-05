import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Replica, contentHash } from "../src/engine.js";
import { SqliteReplicaStore } from "../src/sqlite/store.js";
import { CRASH_DATASET, CRASH_PAGE_LIMIT, FakeNode, tempDir } from "./fixtures.js";

const CHILD = resolve(import.meta.dir, "crash-child.ts");

async function blobs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const shard of await readdir(join(dir, "blobs"))) {
    for (const name of await readdir(join(dir, "blobs", shard))) out.push(name);
  }
  return out.sort();
}

/** Committed keys must be exactly the keys the committed cursor covers: never fewer, never more. */
async function assertCursorMatchesData(store: SqliteReplicaStore): Promise<number> {
  const state = (await store.open())!;
  const covered = state.cursor === null ? 0 : Number(state.cursor.split(":")[0]);
  const keys = (await store.list({})).map((entry) => entry.key);
  expect(keys).toEqual(CRASH_DATASET.slice(0, covered).map(([key]) => key));
  for (const key of keys) {
    const entry = (await store.get(key))!;
    if (entry.deleted || !entry.content) throw new Error(`${key} lost its content`);
    expect(contentHash((await store.readContent(entry.hash))!)).toBe(entry.hash);
  }
  return covered;
}

describe("crash safety", () => {
  for (const [point, committedPages] of [
    ["afterBlobs", 1],
    ["beforeCommit", 1],
    ["afterCommit", 2],
  ] as const) {
    test(`a kill ${point} on page 2 leaves the cursor never ahead of the data, and the next sync converges`, async () => {
      const dir = await tempDir();
      const child = spawnSync(process.execPath, [CHILD, dir, point], { encoding: "utf8" });
      expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: "SIGKILL", stderr: "" });

      const store = await SqliteReplicaStore.open(dir, { create: false });
      expect(await assertCursorMatchesData(store)).toBe(committedPages * CRASH_PAGE_LIMIT);
      // A crash after the blob link leaves page 2's blobs on disk, unreferenced.
      const expectedOrphans = point === "afterBlobs" || point === "beforeCommit" ? CRASH_PAGE_LIMIT : 0;
      expect((await blobs(dir)).length).toBe(committedPages * CRASH_PAGE_LIMIT + expectedOrphans);

      // The dead holder's lease must lapse before another process may sync.
      let now = Date.now();
      const resumed = await SqliteReplicaStore.open(dir, { create: false, now: () => now });
      expect(await resumed.acquireSyncLease(1000)).toBeNull();
      now += 10 * 60_000;
      const node = new FakeNode();
      for (const [key, value] of CRASH_DATASET) node.put(key, value);
      await new Replica({ store: resumed, transport: node }).sync({ limit: CRASH_PAGE_LIMIT });

      expect(await assertCursorMatchesData(resumed)).toBe(CRASH_DATASET.length);
      // GC removed the orphans: exactly the referenced blobs remain.
      expect(await blobs(dir)).toEqual(CRASH_DATASET.map(([, value]) => contentHash(new TextEncoder().encode(value))).sort());
      expect(await readdir(join(dir, "blobs", ".tmp"))).toEqual([]);
      for (const [key, value] of CRASH_DATASET) {
        const entry = (await resumed.get(key))!;
        if (entry.deleted) throw new Error("unreachable");
        expect(new TextDecoder().decode(await readFile(join(dir, "blobs", entry.hash.slice(0, 2), entry.hash)))).toBe(value);
      }
    }, 30_000);
  }
});
