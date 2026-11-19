import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

test("contentBytes counts the writer's blob and temp files, referenced or not, and is 0 for a missing replica", async () => {
  const dir = await mkdtemp(join(tmpdir(), "content-bytes-"));
  dirs.push(dir);
  expect(await SqliteReplicaStore.contentBytes(join(dir, "absent"))).toBe(0);
  expect(await SqliteReplicaStore.contentBytes(dir)).toBe(0);
  await mkdir(join(dir, "blobs", "ab"), { recursive: true });
  await mkdir(join(dir, "blobs", ".tmp"), { recursive: true });
  await writeFile(join(dir, "blobs", "ab", "ab" + "a".repeat(62)), new Uint8Array(300));
  await writeFile(join(dir, "blobs", ".tmp", `${"a".repeat(64)}.${"b".repeat(12)}`), new Uint8Array(20));
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

describe_foreign();
function describe_foreign(): void {
  async function replicaWithBlob(): Promise<{ store: SqliteReplicaStore; dir: string; hash: string }> {
    const dir = await tempDir();
    const store = await newStore(dir);
    const node = new FakeNode();
    node.put("notes/a", new Uint8Array(100).fill(7));
    await new Replica({ store, transport: node }).sync({});
    const hash = (await store.get("notes/a"))!.hash!;
    return { store, dir, hash };
  }

  test("collectOrphans and contentBytes ignore foreign entries under blobs/ and never throw", async () => {
    const { store, dir, hash } = await replicaWithBlob();
    const blobs = join(dir, "blobs");
    const orphan = "c".repeat(64);
    await mkdir(join(blobs, "cc"), { recursive: true });
    await writeFile(join(blobs, "cc", orphan), new Uint8Array(40)); // real orphan
    await writeFile(join(blobs, "README"), "stray file at the blobs root");
    await writeFile(join(blobs, hash.slice(0, 2), "user-notes.txt"), "not a blob"); // non-hash file in a shard
    await writeFile(join(blobs, ".tmp", "stale.tmp"), "not a writer temp name");
    const decoy = await mkdtemp(join(tmpdir(), "decoy-"));
    dirs.push(decoy);
    await writeFile(join(decoy, "d".repeat(64)), new Uint8Array(500));
    await writeFile(join(decoy, "precious.txt"), "foreign");
    await symlink(decoy, join(blobs, "dd"), "dir"); // symlinked shard pointing at a foreign directory

    expect(await SqliteReplicaStore.contentBytes(dir)).toBe(140); // committed 100 + orphan 40
    expect(await SqliteReplicaStore.collectOrphans(dir)).toBe(1);

    expect(existsSync(join(blobs, "cc", orphan))).toBe(false);
    expect(existsSync(join(blobs, "README"))).toBe(true);
    expect(existsSync(join(blobs, hash.slice(0, 2), "user-notes.txt"))).toBe(true);
    expect(existsSync(join(blobs, ".tmp", "stale.tmp"))).toBe(true);
    expect(existsSync(join(decoy, "d".repeat(64)))).toBe(true);
    expect(existsSync(join(decoy, "precious.txt"))).toBe(true);
    expect(await SqliteReplicaStore.contentBytes(dir)).toBe(100);
    expect((await store.readContent(hash))!.byteLength).toBe(100);
    await store.close();
  });

  test("a stray file where blobs/ should be a directory is skipped, not thrown", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "blobs"), "a file, not a directory");
    expect(await SqliteReplicaStore.contentBytes(dir)).toBe(0);
    expect(await SqliteReplicaStore.collectOrphans(dir)).toBe(0);
  });
}
