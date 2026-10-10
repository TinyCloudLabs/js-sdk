import { chmod, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { SqliteReplicaStore } from "./store.js";
import { config, deviceGrant } from "../../test/fixtures.js";

const dirs: string[] = [];
async function makeStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tc-replica-inspect-"));
  dirs.push(dir);
  const store = await SqliteReplicaStore.open(dir, { create: true });
  await store.init(config());
  await store.installGrant(deviceGrant());
  await store.close();
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function databaseDescriptors(): Promise<string[]> {
  const fds = await readdir("/proc/self/fd");
  const links = await Promise.all(fds.map(async (fd) => readlink(`/proc/self/fd/${fd}`).catch(() => "")));
  return links.filter((link) => /\/replica\.db(?:-wal|-shm)?$/.test(link));
}

describe("SQLite status inspection lifecycle", () => {
  test("closed database inspection leaves the directory listing unchanged", async () => {
    const dir = await makeStore();
    const before = (await readdir(dir)).sort();
    expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    expect((await readdir(dir)).sort()).toEqual(before);
    expect(before).toEqual(["blobs", "replica.db"]);
  });

  test("a directory without write permission can be inspected", async () => {
    const dir = await makeStore();
    await chmod(dir, 0o500);
    try {
      expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    } finally {
      await chmod(dir, 0o700);
    }
  });

  test("a live writer in another process does not block inspection", async () => {
    const dir = await makeStore();
    const dbPath = join(dir, "replica.db");
    const script = `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(dbPath)}); db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE"); console.log("ready"); process.stdin.on("data", () => { db.exec("UPDATE replica SET last_sync_at = '2026-10-10T00:00:00.000Z'; COMMIT"); console.log("committed"); });`;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const started = await reader.read();
    expect(new TextDecoder().decode(started.value)).toContain("ready");
    try {
      const inspection = await Promise.race([
        SqliteReplicaStore.inspect(dir),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("inspection blocked by live writer")), 500)),
      ]);
      expect(inspection).not.toBeNull();
      child.stdin.write("commit");
      const committed = await reader.read();
      expect(new TextDecoder().decode(committed.value)).toContain("committed");
    } finally {
      child.kill();
      await child.exited;
      reader.releaseLock();
    }
    const check = await SqliteReplicaStore.inspect(dir);
    expect(check?.status.lastSyncAt).toBe("2026-10-10T00:00:00.000Z");
  });


  test("Bun releases database descriptors after inspection, cancellation, and repeated inspection", async () => {
    const dir = await makeStore();
    expect(await databaseDescriptors()).toEqual([]);
    const store = await SqliteReplicaStore.open(dir, { create: false });
    await store.status();
    await store.close();
    expect(await databaseDescriptors()).toEqual([]);

    expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    expect(await databaseDescriptors()).toEqual([]);

    const controller = new AbortController();
    const pending = SqliteReplicaStore.inspect(dir, { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
    expect(await databaseDescriptors()).toEqual([]);

    for (let i = 0; i < 100; i++) expect(await SqliteReplicaStore.inspect(dir)).not.toBeNull();
    expect(await databaseDescriptors()).toEqual([]);
  });
});
