import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Replica } from "../engine.js";
import { FAULTS, SqliteReplicaStore, type SqliteReplicaStoreOptions } from "./store.js";
import { FakeNode, newStore, removeTempDirs, tempDir } from "../../test/fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  await removeTempDirs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("contentBytes counts every file under blobs/, referenced or not, and is 0 for a missing replica", async () => {
  const dir = await mkdtemp(join(tmpdir(), "content-bytes-"));
  dirs.push(dir);
  expect(await SqliteReplicaStore.contentBytes(join(dir, "absent"))).toBe(0);
  expect(await SqliteReplicaStore.contentBytes(dir)).toBe(0);
  await mkdir(join(dir, "blobs", "ab"), { recursive: true });
  await mkdir(join(dir, "blobs", ".tmp"), { recursive: true });
  await writeFile(join(dir, "blobs", "ab", "a".repeat(64)), new Uint8Array(300));
  await writeFile(join(dir, "blobs", ".tmp", "leftover"), new Uint8Array(20));
  expect(await SqliteReplicaStore.contentBytes(dir)).toBe(320);
});

test("replacing a value peaks at cap + the replaced bytes on disk and ends within the cap", async () => {
  const cap = 10_000;
  const size = 9_000;
  const dir = await tempDir();
  const peaks: number[] = [];
  const sample = async () => { peaks.push(await SqliteReplicaStore.contentBytes(dir)); };
  let armed = false;
  const store = await newStore(dir, {}, {
    // Net-delta admission as the node adapter applies it: the replaced blob is credited.
    partitionId: "p",
    admit: async (page) => {
      if (page.blobBytes > 0 && (await SqliteReplicaStore.contentBytes(dir)) + page.blobBytes > cap) throw new Error("over budget");
    },
    [FAULTS]: {
      afterBlobs: async () => { if (armed) await sample(); },
    },
  } as SqliteReplicaStoreOptions);
  const node = new FakeNode();
  node.put("notes/a", new Uint8Array(size).fill(1));
  await new Replica({ store, transport: node }).sync({});
  expect(await SqliteReplicaStore.contentBytes(dir)).toBe(size);

  armed = true;
  node.put("notes/a", new Uint8Array(size).fill(2));
  await new Replica({ store, transport: node }).sync({});

  // Both blobs are on disk once the new one lands (the old is unlinked only after the commit).
  expect(peaks[0]).toBeGreaterThan(cap);
  expect(peaks[0]).toBeLessThanOrEqual(cap + size);
  expect(await SqliteReplicaStore.contentBytes(dir)).toBeLessThanOrEqual(cap);
  expect(await SqliteReplicaStore.contentBytes(dir)).toBe(size);
  await store.close();
});
