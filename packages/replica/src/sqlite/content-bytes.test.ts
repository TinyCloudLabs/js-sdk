import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteReplicaStore } from "./store.js";

const dirs: string[] = [];
afterEach(async () => {
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
